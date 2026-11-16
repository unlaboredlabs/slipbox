// The MCP endpoint: Streamable HTTP at /mcp, one stateless server per request,
// authenticated by an agent key whose grants every tool checks.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { type Caller, hashKey } from "./access";
import { UserError } from "./files";
import type { SearchResponse } from "./index/search";
import type { Entry, Memory } from "./memory";
import { NAME } from "./name";
import { VERSION } from "./version";

export const INSTRUCTIONS = `This is your shared memory: Markdown notes kept by every agent you work with, with full history.
- Call start first, with the path you are working in (for example projects/<name>), and follow the profiles it returns.
- Notes go in shared/ (what every agent should know), projects/<name>/ (one project's) and agents/<your name>/ (your own); a folder's profile.md says what belongs in it.
- Search before you write, and update an existing note rather than adding a duplicate.
- Keep each note's first paragraph a true one-line summary of it.
- Keep profile.md files short and current: they are loaded every time.
- When a fact is wrong or out of date, correct it in place; history keeps the old version. When notes disagree, the newer one usually wins.
- Give every change a one-line why.`;

type Args = Record<string, any>;

interface ToolDef {
  name: string;
  description: string;
  input: Record<string, z.ZodType>;
  /** Hints for clients deciding what to ask permission for. */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  /** What the activity log records for a call. */
  event: (a: Args) => { path?: string | null; query?: string | null };
  run: (caller: Caller, a: Args) => Promise<string>;
}

// Replies are plain text, compact, for an agent to read: the dashboard's /api keeps the JSON.

/** At most this many entries of a folder are shown, so a big flat folder cannot flood an agent's context. */
export const MAP_ENTRIES = 200;

/** A version or commit id as agents see it: read, write and history accept this prefix. */
const short = (id: string | null) => (id ? id.slice(0, 12) : "none");
const day = (at: string | null) => (at ? at.slice(0, 10) : "");
const minute = (at: string) => new Date(at).toISOString().slice(0, 16) + "Z";

/** One line per entry: `name[/]  last change  summary`. */
function entryLines(dir: string, entries: Entry[]): string {
  const shown = entries.slice(0, MAP_ENTRIES).map((e) => [e.name + (e.type === "dir" ? "/" : ""), day(e.updatedAt), e.summary].filter(Boolean).join("  "));
  const more = entries.length - shown.length;
  const head = `# /${dir} (${entries.length} ${entries.length === 1 ? "entry" : "entries"}: name, last change, summary)`;
  const tail = more > 0 ? [`${more} more entries are not shown: list a subfolder, or search.`] : [];
  return [head, ...(shown.length ? shown : ["(empty)"]), ...tail].join("\n");
}

/**
 * One block per file, best first: its path and last change, the matching sections' line ranges
 * (with how they matched), then the best section's snippet.
 */
function searchText(r: SearchResponse): string {
  const files = new Map<string, SearchResponse["results"]>();
  for (const x of r.results) files.set(x.path, [...(files.get(x.path) ?? []), x]);
  const how = (x: SearchResponse["results"][number]) => (x.wordRank && x.meaningRank ? "both" : x.wordRank ? "words" : "meaning");
  const blocks = [...files].map(([path, hits]) =>
    [
      `## ${path}  ${day(hits[0].updatedAt)}`.trimEnd(),
      hits.map((x) => `${x.startLine}-${x.endLine}${x.heading ? " " + x.heading : ""} [${how(x)}]`).join("; "),
      hits[0].snippet,
    ].join("\n"),
  );
  const head = r.meaning === "ok" ? [] : ["Meaning search is unavailable: these are word matches only."];
  return [...head, ...(blocks.length ? blocks : ["No notes match."])].join("\n\n");
}

function saved(r: { path: string; version: string | null; commit: string | null }): string {
  if (r.version === null) return `Deleted ${r.path}; history keeps it.`;
  return r.commit ? `Saved ${r.path}, version ${short(r.version)}.` : `${r.path} already has this text, version ${short(r.version)}; nothing changed.`;
}

/** Your name and folder, so an agent knows where its own notes are. */
function whoAmI(caller: Caller): string {
  const folder = `agents/${caller.name.toLowerCase().replace(/ +/g, "-")}/`;
  return `You are ${caller.name}; your own notes go in ${folder}`;
}

const tools = (memory: Memory): ToolDef[] => [
  {
    name: "start",
    description:
      "What to load first: who you are, every profile.md from the root down to `path` (and shared/profile.md), then the map of `path` as list gives it. Call this at the start of a task.",
    input: { path: z.string().optional().describe('A folder such as "projects/shop"; the root if omitted.') },
    annotations: { readOnlyHint: true },
    event: (a) => ({ path: a.path ?? "" }),
    async run(caller, a) {
      const { profiles, map } = await memory.start(caller, a.path);
      const parts = profiles.map((p) => `## ${p.path}\n\n${p.content.trim()}\n`);
      if (!parts.length) parts.push("No profile.md on this path yet.\n");
      return `${whoAmI(caller)}\n\n# Profiles\n\n${parts.join("\n")}\n${entryLines(map.path, map.entries).replace(/^# /, "# Map of ")}`;
    },
  },
  {
    name: "list",
    description: "Folders and files under a path, one per line: name, last change and one-line summary (up to 200).",
    input: { path: z.string().optional().describe('A folder such as "shared"; the root if omitted.') },
    annotations: { readOnlyHint: true },
    event: (a) => ({ path: a.path ?? "" }),
    async run(caller, a) {
      const { path, entries } = await memory.list(caller, a.path);
      return entryLines(path, entries);
    },
  },
  {
    name: "search",
    description:
      "Search notes by words and by meaning. Returns matching files, best first, each with its last change, its matching sections (line range, heading, matched by words, meaning or both) and a snippet. Read a section with read(path, lines).",
    input: {
      query: z.string().describe("What you are looking for, in plain words."),
      path: z.string().optional().describe("Only search under this folder."),
      limit: z.number().int().min(1).max(50).optional().describe("Number of sections, 10 by default."),
    },
    annotations: { readOnlyHint: true },
    event: (a) => ({ path: a.path ?? null, query: a.query }),
    run: async (caller, a) => searchText(await memory.search(caller, a.query, a.path, a.limit)),
  },
  {
    name: "read",
    description:
      "Read a note, or a range of its lines, with its version. Pass the version as baseVersion when you write the file. Pass a version from history to read an old one.",
    input: {
      path: z.string().describe('A file such as "shared/conventions.md".'),
      lines: z.string().optional().describe('A line range such as "10-40", "10-" or "10".'),
      version: z.string().optional().describe("A version from history, to read an old version."),
    },
    annotations: { readOnlyHint: true },
    event: (a) => ({ path: a.path }),
    async run(caller, a) {
      const r = await memory.read(caller, a.path, { lines: a.lines, version: a.version });
      const range = r.lines ? `\nlines: ${r.lines.start}-${r.lines.end} of ${r.lines.total}` : "";
      return `path: ${r.path}\nversion: ${short(r.version)}${range}\n\n${r.content}`;
    },
  },
  {
    name: "write",
    description:
      "Create a note, or replace one. Replacing needs baseVersion (the version you read); if the file changed since, the write is refused and the current version and text come back so you can merge. Prefer edit for small changes. Files are capped in size: split big topics into several notes.",
    input: {
      path: z.string().describe('Lowercase path ending in .md, such as "projects/shop/payments.md".'),
      content: z.string().describe('The whole Markdown text: a "# Title", then a one-paragraph summary, then the rest.'),
      why: z.string().describe("One line: why this change."),
      baseVersion: z.string().optional().describe("The version you read; required when the file exists."),
    },
    event: (a) => ({ path: a.path }),
    run: async (caller, a) => saved(await memory.write(caller, a.path, a.content, a.why, a.baseVersion)),
  },
  {
    name: "edit",
    description:
      "Replace an exact piece of text in a note (old must appear exactly once), or append new text to an existing note when old is empty.",
    input: {
      path: z.string().describe('The note to change, such as "projects/shop/payments.md".'),
      old: z.string().describe("The exact text to replace, copied from read or a search snippet. Empty to append."),
      new: z.string().describe("The replacement text."),
      why: z.string().describe("One line: why this change."),
    },
    event: (a) => ({ path: a.path }),
    run: async (caller, a) => saved(await memory.edit(caller, a.path, a.old, a.new, a.why)),
  },
  {
    name: "delete",
    description: "Remove a note. It stays in history.",
    input: {
      path: z.string().describe('The note to remove, such as "projects/shop/old-plan.md".'),
      why: z.string().describe("One line: why this note goes."),
    },
    annotations: { destructiveHint: true, idempotentHint: true },
    event: (a) => ({ path: a.path }),
    run: async (caller, a) => saved(await memory.delete(caller, a.path, a.why)),
  },
  {
    name: "history",
    description:
      "A note's versions, newest first (version, UTC time, agent, why); read accepts a version. For a folder: its latest changes, to see what changed since you last looked.",
    input: {
      path: z.string().optional().describe('A file such as "shared/conventions.md", or a folder (the root if omitted).'),
      limit: z.number().int().min(1).max(1000).optional().describe("Number of versions or changes, 20 by default."),
    },
    annotations: { readOnlyHint: true },
    event: (a) => ({ path: a.path ?? "" }),
    async run(caller, a) {
      if (a.path?.trim().endsWith(".md")) {
        const { versions } = await memory.history(caller, a.path, a.limit);
        if (!versions.length) return `${a.path.trim()} has no history yet.`;
        return versions.map((v) => `${v.version ? short(v.version) : "deleted"} ${minute(v.at)} ${v.agent}: ${v.why}`).join("\n");
      }
      const { path, changes } = await memory.changes(caller, a.path, a.limit);
      if (!changes.length) return `No changes under /${path} yet.`;
      return changes.map((c) => `${minute(c.at)} ${c.agent} ${c.path}${c.version ? "" : " (deleted)"}: ${c.why}`).join("\n");
    },
  },
];

/** Tools that change notes: an internal error there means nothing was saved. */
const WRITES = new Set(["write", "edit", "delete"]);

function buildServer(memory: Memory, caller: Caller): McpServer {
  const server = new McpServer({ name: NAME, version: VERSION }, { instructions: INSTRUCTIONS });
  for (const t of tools(memory)) {
    server.registerTool(t.name, { description: t.description, inputSchema: t.input, annotations: t.annotations }, async (args: Args) => {
      const where = safeEvent(t, args);
      try {
        const text = await t.run(caller, args);
        await memory.events.log({ agent: caller.name, action: t.name, path: where.path ?? null, query: where.query ?? null, ok: true });
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        await memory.events.log({ agent: caller.name, action: t.name, path: where.path ?? null, query: where.query ?? null, ok: false });
        return { isError: true, content: [{ type: "text" as const, text: errorText(err, WRITES.has(t.name)) }] };
      }
    });
  }
  return server;
}

function safeEvent(t: ToolDef, args: Args) {
  try {
    return t.event(args);
  } catch {
    return {};
  }
}

function errorText(err: unknown, write: boolean): string {
  if (err instanceof UserError) {
    const d = err.details as { content?: string | null; outline?: string } | undefined;
    if (err.code === "stale" && d?.content) return `${err.message}\n\n${d.content}`;
    if (err.code === "exists" && d?.outline) return `${err.message}\n\n${d.outline}`;
    return err.message;
  }
  // The details (paths on the server, a stack) go to the server's log, not to the agent.
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  return write ? "Internal error; nothing was saved. Retry the call; the server log has the details." : "Internal error; the server log has the details.";
}

function unauthorized(message: string) {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32001, message }, id: null },
    { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="mcp"' } },
  );
}

/** Handles a request to /mcp. */
export async function handleMcp(req: Request, memory: Memory): Promise<Response> {
  const key = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1]?.trim();
  if (!key) return unauthorized(`Send an agent key: Authorization: Bearer <key>. Create one with "${NAME} key create".`);
  const agent = await memory.store.agentByKeyHash(hashKey(key));
  if (!agent) return unauthorized("This key is not valid or has been revoked.");
  memory.store.touchAgent(agent.id).catch(() => {});

  // Stateless: a fresh server and transport per request, so any instance can answer any call.
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = buildServer(memory, { name: agent.name, grants: agent.grants });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // With JSON responses the reply is complete here.
    server.close().catch(() => {});
  }
}
