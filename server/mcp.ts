// The MCP endpoint: Streamable HTTP at /mcp, one stateless server per request,
// authenticated by an agent key whose grants every tool checks.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { type Caller, hashKey } from "./access";
import { UserError } from "./files";
import type { Entry, Memory } from "./memory";
import { NAME } from "./name";
import { VERSION } from "./version";

export const INSTRUCTIONS = `This is your shared memory: Markdown notes kept by every agent you work with, with full history.
- Call start first, with the path you are working in (for example projects/<name>), and follow the profiles it returns. shared/profile.md holds what every agent should know.
- Search before you write, and update an existing note rather than adding a duplicate.
- Keep each note's first paragraph a true one-line summary of it.
- Keep profile.md files short and current: they are loaded every time.
- When a fact is wrong or out of date, correct it in place; history keeps the old version.
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

const json = (v: unknown) => JSON.stringify(v);

/** At most this many entries of a folder are shown, so a big flat folder cannot flood an agent's context. */
export const MAP_ENTRIES = 200;

function capped(entries: Entry[]): { entries: Entry[]; more?: string } {
  if (entries.length <= MAP_ENTRIES) return { entries };
  const more = `${entries.length - MAP_ENTRIES} more entries are not shown: list a subfolder, or search.`;
  return { entries: entries.slice(0, MAP_ENTRIES), more };
}

const tools = (memory: Memory): ToolDef[] => [
  {
    name: "start",
    description:
      "What to load first: shared/profile.md and every profile.md from the root down to `path`, then the map of `path` (its folders and files with one-line summaries, up to 200). Call this at the start of a task.",
    input: { path: z.string().optional().describe('A folder such as "projects/shop"; the root if omitted.') },
    annotations: { readOnlyHint: true },
    event: (a) => ({ path: a.path ?? "" }),
    async run(caller, a) {
      const { profiles, map } = await memory.start(caller, a.path);
      const parts = profiles.map((p) => `## ${p.path}\n\n${p.content.trim()}\n`);
      if (!parts.length) parts.push("No profile.md on this path yet.\n");
      const { entries, more } = capped(map.entries);
      return `# Profiles\n\n${parts.join("\n")}\n# Map of /${map.path}\n\n${json(entries)}${more ? `\n\n${more}` : ""}`;
    },
  },
  {
    name: "list",
    description: "Folders and files under a path, each with its one-line summary, size and last change (up to 200).",
    input: { path: z.string().optional().describe('A folder such as "shared"; the root if omitted.') },
    annotations: { readOnlyHint: true },
    event: (a) => ({ path: a.path ?? "" }),
    async run(caller, a) {
      const { path, entries } = await memory.list(caller, a.path);
      return json({ path, ...capped(entries) });
    },
  },
  {
    name: "search",
    description:
      "Search notes by words and by meaning. Returns matching sections: path, heading, line range, snippet, score, and wordRank / meaningRank saying which of the two matched. Read a result with read(path, lines).",
    input: {
      query: z.string().describe("What you are looking for, in plain words."),
      path: z.string().optional().describe("Only search under this folder."),
      limit: z.number().int().min(1).max(50).optional().describe("Number of results, 10 by default."),
    },
    annotations: { readOnlyHint: true },
    event: (a) => ({ path: a.path ?? null, query: a.query }),
    run: async (caller, a) => json(await memory.search(caller, a.query, a.path, a.limit)),
  },
  {
    name: "read",
    description:
      "Read a note, or a range of its lines, with its version. Pass the version as baseVersion when you write the file. Pass a version from history to read an old one.",
    input: {
      path: z.string().describe('A file such as "shared/conventions.md".'),
      lines: z.string().optional().describe('A line range such as "10-40", "10-" or "10".'),
      version: z.string().optional().describe("A version or commit from history, to read an old version."),
    },
    annotations: { readOnlyHint: true },
    event: (a) => ({ path: a.path }),
    async run(caller, a) {
      const r = await memory.read(caller, a.path, { lines: a.lines, version: a.version });
      const range = r.lines ? `\nlines: ${r.lines.start}-${r.lines.end} of ${r.lines.total}` : "";
      return `path: ${r.path}\nversion: ${r.version}${range}\n\n${r.content}`;
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
    run: async (caller, a) => json(await memory.write(caller, a.path, a.content, a.why, a.baseVersion)),
  },
  {
    name: "edit",
    description:
      "Replace an exact piece of text in a note (old must appear exactly once), or append new text when old is empty.",
    input: {
      path: z.string().describe('The note to change, such as "projects/shop/payments.md".'),
      old: z.string().describe("The exact text to replace, copied from read. Empty to append."),
      new: z.string().describe("The replacement text."),
      why: z.string().describe("One line: why this change."),
    },
    event: (a) => ({ path: a.path }),
    run: async (caller, a) => json(await memory.edit(caller, a.path, a.old, a.new, a.why)),
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
    run: async (caller, a) => json(await memory.delete(caller, a.path, a.why)),
  },
  {
    name: "history",
    description: "A note's versions, newest first: when, which agent, and why. read accepts a version from here.",
    input: {
      path: z.string().describe('A file such as "shared/conventions.md".'),
      limit: z.number().int().min(1).max(1000).optional().describe("Number of versions, 20 by default."),
    },
    annotations: { readOnlyHint: true },
    event: (a) => ({ path: a.path }),
    run: async (caller, a) => json(await memory.history(caller, a.path, a.limit)),
  },
];

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
        return { isError: true, content: [{ type: "text" as const, text: errorText(err) }] };
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

function errorText(err: unknown): string {
  if (err instanceof UserError) {
    if (err.code === "stale" && err.details) {
      const { version, content } = err.details as { version: string | null; content: string | null };
      return content === null ? err.message : `${err.message}\n\ncurrent version: ${version}\n\n${content}`;
    }
    return err.message;
  }
  // The details (paths on the server, a stack) go to the server's log, not to the agent.
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  return "Internal error; the server log has the details.";
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
