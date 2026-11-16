// A mock of the dashboard API in DESIGN.md, for developing the dashboard without the server.
//
//   bun run mock                    serves /api on PORT (default 3000), admin token "dev"
//   ADMIN_TOKEN=x MEANING=off ...   another token; search answering by words only
//
// Simulated agents keep reading, searching and editing, so Activity has a live stream.
// When web/dist exists it is served too, so the built dashboard can be checked here.

import { join } from "node:path";
import { seedAgents, seedFiles } from "./data";

const PORT = Number(process.env.PORT ?? 3000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "dev";
const MEANING = process.env.MEANING !== "off";
const DIST = join(import.meta.dir, "..", "dist");

// ---------- state ----------

type Version = { version: string; commit: string; at: string; agent: string; why: string; content: string };
type Grant = { prefix: string; mode: "read" | "write" };
type Agent = { id: string; name: string; createdAt: string; lastSeenAt: string | null; revoked: boolean; grants: Grant[] };
type Event = { id: number; at: string; agent: string; action: string; path: string | null; query: string | null; ok: boolean };

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
const hash = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 16);

const files = new Map<string, Version[]>(); // newest last
for (const seed of seedFiles) {
  files.set(
    seed.path,
    seed.versions.map((v) => ({ version: hash(v.content), commit: hex(20), at: ago(v.hoursAgo * 3600_000), agent: v.agent, why: v.why, content: v.content })),
  );
}

const agents: Agent[] = seedAgents.map((a) => ({
  id: hex(6),
  name: a.name,
  createdAt: ago(a.daysOld * 86400_000),
  lastSeenAt: ago(a.seenMinutesAgo * 60_000),
  revoked: "revoked" in a ? a.revoked : false,
  grants: a.grants.map((g) => ({ ...g })),
}));

const events: Event[] = []; // oldest first
let nextEventId = 1;
const listeners = new Set<(e: Event) => void>();

function logEvent(e: Omit<Event, "id" | "at"> & { at?: string }) {
  const event: Event = { id: nextEventId++, at: e.at ?? new Date().toISOString(), ...e };
  events.push(event);
  for (const listener of listeners) listener(event);
  const agent = agents.find((a) => a.name === e.agent);
  if (agent) agent.lastSeenAt = event.at;
}

// ---------- helpers ----------

const current = (path: string) => files.get(path)?.at(-1);
const bytes = (text: string) => new TextEncoder().encode(text).length;

function titleAndSummary(content: string) {
  const lines = content.split("\n");
  const titleAt = lines.findIndex((l) => l.startsWith("# "));
  const title = titleAt >= 0 ? lines[titleAt]!.slice(2).trim() : "";
  const rest = lines.slice(titleAt + 1);
  const start = rest.findIndex((l) => l.trim() !== "");
  const end = rest.findIndex((l, i) => i > start && l.trim() === "");
  const summary = start >= 0 ? rest.slice(start, end < 0 ? undefined : end).join(" ").trim() : "";
  return { title, summary: summary.startsWith("#") ? "" : summary };
}

function fileJson(path: string, v: Version) {
  return { path, ...titleAndSummary(v.content), content: v.content, version: v.version, bytes: bytes(v.content), updatedAt: v.at };
}

function tree(prefix: string) {
  const entries = new Map<string, { name: string; path: string; type: "dir" | "file"; summary: string; bytes: number; updatedAt: string }>();
  for (const [path, versions] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const [name, ...below] = rest.split("/");
    const latest = versions.at(-1)!;
    if (below.length === 0) {
      entries.set(name!, { name: name!, path, type: "file", summary: titleAndSummary(latest.content).summary, bytes: bytes(latest.content), updatedAt: latest.at });
    } else {
      const dir = entries.get(name!) ?? { name: name!, path: `${prefix}${name}/`, type: "dir" as const, summary: "", bytes: 0, updatedAt: latest.at };
      dir.bytes += bytes(latest.content);
      if (latest.at > dir.updatedAt) dir.updatedAt = latest.at;
      if (below.join("/") === "profile.md") dir.summary = titleAndSummary(latest.content).summary;
      entries.set(name!, dir);
    }
  }
  return [...entries.values()].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
}

/** A unified diff between two texts, three lines of context. */
function unifiedDiff(path: string, a: string, b: string) {
  const x = a === "" ? [] : a.replace(/\n$/, "").split("\n");
  const y = b.replace(/\n$/, "").split("\n");
  const lcs = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--) lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);

  type Op = { kind: " " | "-" | "+"; text: string; ai: number; bi: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) ops.push({ kind: " ", text: x[i]!, ai: i++, bi: j++ });
    else if (j < y.length && (i >= x.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) ops.push({ kind: "+", text: y[j]!, ai: i, bi: j++ });
    else ops.push({ kind: "-", text: x[i]!, ai: i++, bi: j });
  }

  const out = [`diff --git a/${path} b/${path}`, `--- ${a === "" ? "/dev/null" : `a/${path}`}`, `+++ b/${path}`];
  const changed = ops.map((op, k) => (op.kind !== " " ? k : -1)).filter((k) => k >= 0);
  let k = 0;
  while (k < changed.length) {
    let start = Math.max(0, changed[k]! - 3);
    let end = Math.min(ops.length, changed[k]! + 4);
    while (k + 1 < changed.length && changed[k + 1]! - 3 <= end) end = Math.min(ops.length, changed[++k]! + 4);
    k++;
    const hunk = ops.slice(start, end);
    const aLen = hunk.filter((o) => o.kind !== "+").length;
    const bLen = hunk.filter((o) => o.kind !== "-").length;
    out.push(`@@ -${aLen ? hunk[0]!.ai + 1 : 0},${aLen} +${hunk[0]!.bi + 1},${bLen} @@`);
    for (const op of hunk) out.push(op.kind + op.text);
  }
  return out.join("\n") + "\n";
}

// ---------- search ----------

type Section = { path: string; heading: string; startLine: number; endLine: number; text: string };

function sections(): Section[] {
  const all: Section[] = [];
  for (const [path] of files) {
    const lines = current(path)!.content.split("\n");
    let heading = "";
    let start = 0;
    const flush = (end: number) => {
      const text = lines.slice(start, end).join("\n").trim();
      if (text) all.push({ path, heading, startLine: start + 1, endLine: end, text });
    };
    lines.forEach((line, n) => {
      if (/^#{1,6} /.test(line) && n > 0) {
        flush(n);
        start = n;
      }
      if (/^#{1,6} /.test(line)) heading = line.replace(/^#+ /, "");
    });
    flush(lines.length);
  }
  return all;
}

const words = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
const trigrams = (s: string) => {
  const t = new Set<string>();
  for (const w of words(s)) for (let i = 0; i + 3 <= w.length; i++) t.add(w.slice(i, i + 3));
  return t;
};

function search(q: string, prefix: string, limit: number) {
  const all = sections().filter((s) => s.path.startsWith(prefix));
  const terms = words(q);

  const byWords = all
    .map((s) => ({ s, score: terms.reduce((sum, t) => sum + (words(s.text).filter((w) => w.startsWith(t)).length + (words(s.heading).includes(t) ? 2 : 0)), 0) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.s);

  const qt = trigrams(q);
  const byMeaning = MEANING
    ? all
        .map((s) => {
          const st = trigrams(s.text);
          let common = 0;
          for (const t of qt) if (st.has(t)) common++;
          return { s, score: common / Math.sqrt(qt.size * st.size || 1) };
        })
        .filter((r) => r.score > 0.06)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)
        .map((r) => r.s)
    : [];

  const merged = new Map<Section, { wordRank: number | null; meaningRank: number | null; score: number }>();
  const add = (list: Section[], key: "wordRank" | "meaningRank") =>
    list.forEach((s, i) => {
      const r = merged.get(s) ?? { wordRank: null, meaningRank: null, score: 0 };
      r[key] = i + 1;
      r.score += 1 / (60 + i + 1);
      merged.set(s, r);
    });
  add(byWords, "wordRank");
  add(byMeaning, "meaningRank");

  return [...merged.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limit)
    .map(([s, r]) => ({ path: s.path, heading: s.heading, startLine: s.startLine, endLine: s.endLine, snippet: snippet(s.text, terms), score: Number(r.score.toFixed(4)), wordRank: r.wordRank, meaningRank: r.meaningRank }));
}

function snippet(text: string, terms: string[]) {
  const body = text.replace(/^#+ .*\n?/, "").replace(/\s+/g, " ").trim();
  const lower = body.toLowerCase();
  const at = Math.min(...terms.map((t) => lower.indexOf(t)).filter((n) => n >= 0), Infinity);
  const start = at === Infinity || at < 60 ? 0 : body.lastIndexOf(" ", at - 50) + 1;
  const cut = body.slice(start, start + 220);
  return (start > 0 ? "…" : "") + cut + (start + 220 < body.length ? "…" : "");
}

// ---------- embedding progress, for /api/health ----------

let embedded = 0;
const totalSections = () => sections().length;
setInterval(() => {
  if (MEANING) embedded = Math.min(totalSections(), embedded + 3);
}, 1500);

// ---------- simulated agents ----------

const queries = ["checkout webhook", "how do we deploy", "backup restore time", "who to ask about payments", "commit message style", "shipping rates cache", "card data compliance", "staging database reset"];

function simulate() {
  const active = agents.filter((a) => !a.revoked);
  const agent = active[Math.floor(Math.random() * active.length)]!;
  const readable = [...files.keys()].filter((p) => agent.grants.some((g) => p.startsWith(g.prefix)));
  const path = readable[Math.floor(Math.random() * readable.length)] ?? null;
  const roll = Math.random();
  if (roll < 0.35) logEvent({ agent: agent.name, action: "search", path: null, query: queries[Math.floor(Math.random() * queries.length)]!, ok: true });
  else if (roll < 0.7) logEvent({ agent: agent.name, action: "read", path, query: null, ok: true });
  else if (roll < 0.8) logEvent({ agent: agent.name, action: "list", path: path?.split("/").slice(0, -1).join("/") + "/", query: null, ok: true });
  else if (roll < 0.86) logEvent({ agent: agent.name, action: "start", path: null, query: null, ok: true });
  else if (roll < 0.95 && path) {
    const writable = agent.grants.some((g) => g.mode === "write" && path.startsWith(g.prefix));
    if (writable && path.startsWith("agents/")) {
      const v = current(path)!;
      const content = v.content.trimEnd() + `\n- Seen at ${new Date().toISOString().slice(11, 16)} UTC: nothing new.\n`;
      files.get(path)!.push({ version: hash(content), commit: hex(20), at: new Date().toISOString(), agent: agent.name, why: "Note a quiet check", content });
      embedded = Math.max(0, embedded - 2);
    }
    logEvent({ agent: agent.name, action: "edit", path, query: null, ok: writable && path.startsWith("agents/") });
  } else logEvent({ agent: agent.name, action: "write", path: "shared/conventions.md", query: null, ok: false });
}

// A few hours of history, then a new event every few seconds.
for (let n = 80; n > 0; n--) {
  simulate();
  events.at(-1)!.at = ago(n * 4 * 60_000 + Math.random() * 120_000);
}
const tick = () => {
  simulate();
  setTimeout(tick, 2500 + Math.random() * 4000);
};
setTimeout(tick, 3000);

// ---------- http ----------

const json = (data: unknown, status = 200) => Response.json(data, { status });
const readBody = async (req: Request) => (await req.json().catch(() => ({}))) as Record<string, any>;
const fail = (status: number, code: string, message: string) => json({ error: { code, message } }, status);

function validGrants(grants: unknown): grants is Grant[] {
  return Array.isArray(grants) && grants.every((g) => g && typeof g.prefix === "string" && (g.mode === "read" || g.mode === "write"));
}

async function handleApi(req: Request, url: URL): Promise<Response> {
  if (req.headers.get("authorization") !== `Bearer ${ADMIN_TOKEN}`) return fail(401, "unauthorized", "Admin token required");
  const p = url.searchParams;
  const route = `${req.method} ${url.pathname}`;

  if (route === "GET /api/health") {
    const total = totalSections();
    return json({ ok: true, db: "sqlite", embed: { model: "Xenova/bge-small-en-v1.5", loaded: MEANING, embedded: MEANING ? embedded : 0, total, queued: MEANING ? total - embedded : total, lastError: MEANING ? null : "Embedding model disabled (EMBED_MODEL=off)" } });
  }
  if (route === "GET /api/tree") {
    const path = p.get("path") ?? "";
    return json({ path, entries: tree(path && !path.endsWith("/") ? `${path}/` : path) });
  }
  if (route === "GET /api/file") {
    const path = p.get("path") ?? "";
    const versions = files.get(path);
    if (!versions) return fail(404, "not_found", `No file at ${path}`);
    const want = p.get("version");
    const v = want ? versions.find((x) => x.version === want || x.commit === want) : versions.at(-1);
    if (!v) return fail(404, "not_found", `No version ${want} of ${path}`);
    return json(fileJson(path, v));
  }
  if (route === "GET /api/history") {
    const versions = files.get(p.get("path") ?? "");
    if (!versions) return fail(404, "not_found", "No such file");
    const limit = Number(p.get("limit") ?? 50);
    return json({ versions: versions.slice().reverse().slice(0, limit).map(({ content: _, ...v }) => v) });
  }
  if (route === "GET /api/diff") {
    const path = p.get("path") ?? "";
    const versions = files.get(path);
    const to = versions?.find((v) => v.commit === p.get("to"));
    const from = p.get("from") ? versions?.find((v) => v.commit === p.get("from")) : undefined;
    if (!to || (p.get("from") && !from)) return fail(404, "not_found", "Unknown commit");
    return json({ diff: unifiedDiff(path, from?.content ?? "", to.content) });
  }
  if (route === "POST /api/restore") {
    const body = await readBody(req);
    const versions = files.get(body.path);
    const old = versions?.find((v) => v.commit === body.commit);
    if (!versions || !old) return fail(404, "not_found", "Unknown file or commit");
    await Bun.sleep(400);
    const restored: Version = { ...old, commit: hex(20), at: new Date().toISOString(), agent: "admin", why: `Restore version from ${old.at.slice(0, 10)}` };
    versions.push(restored);
    logEvent({ agent: "admin", action: "restore", path: body.path, query: null, ok: true });
    return json({ version: restored.version });
  }
  if (route === "GET /api/search") {
    const q = (p.get("q") ?? "").trim();
    if (!q) return fail(400, "bad_request", "q is required");
    await Bun.sleep(150);
    logEvent({ agent: "admin", action: "search", path: p.get("path") || null, query: q, ok: true });
    return json({ meaning: MEANING ? "ok" : "unavailable", results: search(q, p.get("path") ?? "", Number(p.get("limit") ?? 20)) });
  }
  if (route === "GET /api/events") {
    const after = Number(p.get("after") ?? 0);
    const agent = p.get("agent");
    const limit = Number(p.get("limit") ?? 100);
    const list = events.filter((e) => e.id > after && (!agent || e.agent === agent));
    return json({ events: list.slice(-limit).reverse() });
  }
  if (route === "GET /api/events/stream") {
    let listener: (e: Event) => void;
    let keepAlive: Timer;
    const stream = new ReadableStream({
      start(controller) {
        const send = (chunk: string) => controller.enqueue(new TextEncoder().encode(chunk));
        listener = (e) => send(`data: ${JSON.stringify(e)}\n\n`);
        listeners.add(listener);
        keepAlive = setInterval(() => send(": keep-alive\n\n"), 8000);
        send(": connected\n\n");
      },
      cancel() {
        listeners.delete(listener);
        clearInterval(keepAlive);
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
  }
  if (route === "GET /api/agents") return json({ agents });
  if (route === "POST /api/agents") {
    const body = await readBody(req);
    const name = String(body.name ?? "").trim();
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) return fail(400, "bad_request", "Name must be lowercase letters, digits, dots, dashes or underscores");
    if (agents.some((a) => a.name === name)) return fail(409, "conflict", `An agent named ${name} already exists`);
    if (!validGrants(body.grants)) return fail(400, "bad_request", "Invalid grants");
    const agent: Agent = { id: hex(6), name, createdAt: new Date().toISOString(), lastSeenAt: null, revoked: false, grants: body.grants };
    agents.push(agent);
    return json({ agent, key: `ctx_${hex(24)}` });
  }
  const patch = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
  if (req.method === "PATCH" && patch) {
    const agent = agents.find((a) => a.id === patch[1]);
    if (!agent) return fail(404, "not_found", "No such agent");
    const body = await readBody(req);
    if (body.grants !== undefined) {
      if (!validGrants(body.grants)) return fail(400, "bad_request", "Invalid grants");
      agent.grants = body.grants;
    }
    if (typeof body.revoked === "boolean") agent.revoked = body.revoked;
    return json({ agent });
  }
  return fail(404, "not_found", `No route ${route}`);
}

async function handleStatic(url: URL): Promise<Response> {
  const file = Bun.file(join(DIST, url.pathname));
  if (url.pathname !== "/" && !url.pathname.includes("..") && (await file.exists())) return new Response(file);
  const index = Bun.file(join(DIST, "index.html"));
  return (await index.exists()) ? new Response(index) : new Response("Not found", { status: 404 });
}

Bun.serve({
  port: PORT,
  idleTimeout: 0,
  fetch(req) {
    const url = new URL(req.url);
    return url.pathname.startsWith("/api/") ? handleApi(req, url) : handleStatic(url);
  },
});

console.log(`mock API on http://localhost:${PORT}/api  (admin token: ${ADMIN_TOKEN}${MEANING ? "" : ", meaning off"})`);
