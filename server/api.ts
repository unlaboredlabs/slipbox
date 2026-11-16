// The dashboard's HTTP API (/api), authenticated by ADMIN_TOKEN. See DESIGN.md for the contract.
import { ADMIN, checkGrants, createAgent, sameSecret } from "./access";
import type { Event } from "./db";
import { UserError } from "./files";
import type { Memory } from "./memory";
import { VERSION } from "./version";

type Handler = (req: Request, url: URL, params: string[]) => Promise<unknown>;

export function apiHandler(memory: Memory, adminToken: string) {
  const { store } = memory;
  const routes: [string, RegExp, Handler][] = [
    ["GET", /^\/api\/health$/, async () => ({ ok: true, db: store.kind, version: VERSION, embed: memory.embeddings.status() })],
    ["GET", /^\/api\/tree$/, async (_r, u) => memory.list(ADMIN, u.searchParams.get("path") ?? "")],
    [
      "GET",
      /^\/api\/file$/,
      async (_r, u) => {
        const { lines: _, ...file } = await memory.read(ADMIN, need(u, "path"), { version: u.searchParams.get("version") || undefined });
        return file;
      },
    ],
    ["GET", /^\/api\/history$/, async (_r, u) => memory.history(ADMIN, need(u, "path"), int(u, "limit", 50))],
    ["GET", /^\/api\/diff$/, async (_r, u) => memory.diff(ADMIN, need(u, "path"), u.searchParams.get("from") || undefined, need(u, "to"))],
    [
      "POST",
      /^\/api\/restore$/,
      async (req) => {
        const body = await jsonBody(req);
        if (typeof body.path !== "string" || typeof body.commit !== "string") {
          throw new UserError("bad_request", "Send { path, commit }.");
        }
        let ok = false;
        try {
          const r = await memory.restore(ADMIN, body.path, body.commit);
          ok = true;
          return { version: r.version };
        } finally {
          await memory.events.log({ agent: ADMIN.name, action: "restore", path: body.path, query: null, ok });
        }
      },
    ],
    [
      "GET",
      /^\/api\/search$/,
      async (_r, u) => memory.search(ADMIN, need(u, "q"), u.searchParams.get("path") ?? undefined, int(u, "limit", 10)),
    ],
    [
      "GET",
      /^\/api\/events$/,
      async (_r, u) => ({
        events: await store.events({
          after: int(u, "after", 0),
          limit: int(u, "limit", 100),
          agent: u.searchParams.get("agent") || undefined,
        }),
      }),
    ],
    ["GET", /^\/api\/agents$/, async () => ({ agents: await store.listAgents() })],
    [
      "POST",
      /^\/api\/agents$/,
      async (req) => {
        const body = await jsonBody(req);
        return createAgent(store, body.name, body.grants);
      },
    ],
    [
      "PATCH",
      /^\/api\/agents\/(\d+)$/,
      async (req, _u, [id]) => {
        const body = await jsonBody(req);
        const agent = await store.getAgent(Number(id));
        if (!agent) throw new UserError("not_found", `No agent ${id}.`, 404);
        if (body.revoked !== undefined && typeof body.revoked !== "boolean") {
          throw new UserError("bad_request", "revoked is true or false.");
        }
        if (agent.revoked && body.revoked === false) {
          throw new UserError("bad_request", "Revoking a key is final. Create a new key instead.");
        }
        await store.updateAgent(agent.id, {
          grants: body.grants === undefined ? undefined : checkGrants(body.grants),
          revoked: body.revoked,
        });
        return { agent: await store.getAgent(agent.id) };
      },
    ],
  ];

  return async (req: Request, server: Bun.Server<unknown>): Promise<Response> => {
    const url = new URL(req.url);
    // Only from the header: a token in a URL ends up in logs and shell history.
    const token = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1]?.trim();
    if (!token || !adminToken || !sameSecret(token, adminToken)) {
      return error(new UserError("unauthorized", "Send the admin token: Authorization: Bearer <ADMIN_TOKEN>.", 401));
    }
    if (req.method === "GET" && url.pathname === "/api/events/stream") {
      server.timeout(req, 0);
      return eventStream(memory, req.signal);
    }
    for (const [method, pattern, handler] of routes) {
      const m = pattern.exec(url.pathname);
      if (!m) continue;
      if (req.method !== method) continue;
      try {
        return Response.json(await handler(req, url, m.slice(1)));
      } catch (err) {
        return error(err);
      }
    }
    return error(new UserError("not_found", `No route ${req.method} ${url.pathname}.`, 404));
  };
}

function eventStream(memory: Memory, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  let stop = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          stop();
        }
      };
      const unsubscribe = memory.events.subscribe((e: Event) => send(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`));
      // A comment now and then keeps proxies from closing an idle stream.
      const ping = setInterval(() => send(": ping\n\n"), 20_000);
      stop = () => {
        unsubscribe();
        clearInterval(ping);
      };
      signal.addEventListener("abort", () => {
        stop();
        try {
          controller.close();
        } catch {}
      });
      send(": connected\n\n");
    },
    cancel() {
      stop();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}

function need(u: URL, name: string): string {
  const v = u.searchParams.get(name);
  if (!v) throw new UserError("bad_request", `${name} is required.`);
  return v;
}

function int(u: URL, name: string, fallback: number): number {
  const v = u.searchParams.get(name);
  if (v === null || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new UserError("bad_request", `${name} must be a whole number.`);
  return n;
}

async function jsonBody(req: Request): Promise<Record<string, any>> {
  try {
    const body = await req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body;
  } catch {}
  throw new UserError("bad_request", "Send a JSON object.");
}

export function error(err: unknown): Response {
  if (err instanceof UserError) {
    return Response.json({ error: { code: err.code, message: err.message } }, { status: err.status });
  }
  // The stack as text: an error object prints source excerpts into the log.
  console.error(err instanceof Error ? err.stack : err);
  const message = err instanceof Error ? err.message : String(err);
  return Response.json({ error: { code: "internal", message } }, { status: 500 });
}
