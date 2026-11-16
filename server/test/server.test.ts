// The running server: MCP tools through the official SDK client, grants on
// every tool, the activity log, and the dashboard API.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createAgent } from "../access";
import type { Config } from "../config";
import { startServer } from "../index";
import { INSTRUCTIONS } from "../mcp";
import { type Env, WordsEmbedder, backend, makeEnv, until } from "./helpers";

const ADMIN_TOKEN = "test-admin-token";

async function connect(url: string, key: string) {
  const client = new Client({ name: "test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url + "/mcp"), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }),
  );
  return client;
}

const text = (r: any): string => r.content[0].text;

describe(`server (${backend})`, () => {
  let env: Env;
  let app: Awaited<ReturnType<typeof startServer>>;
  let writer: Client;
  let reader: Client;
  let readerKey: string;

  const api = (path: string, init: RequestInit = {}): Promise<Omit<Response, "json"> & { json(): Promise<any> }> =>
    fetch(app.url + path, {
      ...init,
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json", ...init.headers },
    });

  beforeAll(async () => {
    env = await makeEnv();
    const config: Config = {
      dataDir: env.dataDir,
      databaseUrl: env.dbUrl,
      adminToken: ADMIN_TOKEN,
      host: "127.0.0.1",
      port: 0,
      maxFileBytes: 32 * 1024,
      embedModel: "test/words",
      modelsDir: env.dir,
      configFile: "",
      serviceName: "",
    };
    app = await startServer(config, { embedder: new WordsEmbedder() });
    const w = await createAgent(app.store, "writer", [{ prefix: "", mode: "write" }]);
    const r = await createAgent(app.store, "reader", [
      { prefix: "shared/", mode: "read" },
      { prefix: "agents/reader/", mode: "write" },
    ]);
    readerKey = r.key;
    writer = await connect(app.url, w.key);
    reader = await connect(app.url, r.key);
  });

  afterAll(async () => {
    await writer?.close();
    await reader?.close();
    await app?.stop();
    await env.cleanup();
  });

  test("lists the eight tools and gives the instructions", async () => {
    const { tools } = await writer.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["delete", "edit", "history", "list", "read", "search", "start", "write"]);
    expect(writer.getInstructions()).toBe(INSTRUCTIONS);
  });

  test("refuses a missing, wrong or revoked key", async () => {
    const res = await fetch(app.url + "/mcp", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    expect(res.status).toBe(401);
    await expect(connect(app.url, "sk_wrong")).rejects.toThrow();
    const temp = await createAgent(app.store, "temp", [{ prefix: "", mode: "read" }]);
    const client = await connect(app.url, temp.key);
    await api(`/api/agents/${temp.agent.id}`, { method: "PATCH", body: JSON.stringify({ revoked: true }) });
    await expect(client.callTool({ name: "list", arguments: {} })).rejects.toThrow();
  });

  test("write, search, edit, history and read an old version", async () => {
    let r = await writer.callTool({
      name: "write",
      arguments: { path: "shared/stack.md", content: "# Stack\n\nWe deploy with Kamal.\n", why: "record the deploy tool" },
    });
    expect(r.isError).toBeFalsy();
    const first = JSON.parse(text(r));
    expect(first.commit).toMatch(/^[0-9a-f]{40}$/);

    r = await writer.callTool({ name: "search", arguments: { query: "kamal" } });
    expect(JSON.parse(text(r)).results[0]).toMatchObject({ path: "shared/stack.md", wordRank: 1 });

    r = await writer.callTool({ name: "write", arguments: { path: "shared/stack.md", content: "# Stack\n\nx\n", why: "no base" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(`current version: ${first.version}`);
    expect(text(r)).toContain("We deploy with Kamal.");

    r = await writer.callTool({
      name: "edit",
      arguments: { path: "shared/stack.md", old: "Kamal", new: "Docker Compose", why: "switched deploy tool" },
    });
    expect(r.isError).toBeFalsy();

    r = await writer.callTool({ name: "history", arguments: { path: "shared/stack.md" } });
    const { versions } = JSON.parse(text(r));
    expect(versions.map((v: any) => [v.agent, v.why])).toEqual([
      ["writer", "switched deploy tool"],
      ["writer", "record the deploy tool"],
    ]);

    r = await writer.callTool({ name: "read", arguments: { path: "shared/stack.md", version: versions[1].version } });
    expect(text(r)).toContain("We deploy with Kamal.");
    r = await writer.callTool({ name: "read", arguments: { path: "shared/stack.md" } });
    expect(text(r)).toContain("Docker Compose");
    expect(text(r)).toContain(`version: ${versions[0].version}`);
  });

  test("grants are enforced on every tool", async () => {
    await writer.callTool({ name: "write", arguments: { path: "projects/secret/plan.md", content: "# Plan\n\nhidden zebra\n", why: "w" } });
    await writer.callTool({ name: "write", arguments: { path: "shared/profile.md", content: "# Team\n\nShared facts.\n", why: "w" } });
    await writer.callTool({ name: "write", arguments: { path: "profile.md", content: "# Root\n\nRoot facts.\n", why: "w" } });

    const denied = async (name: string, args: Record<string, unknown>) => {
      const r = await reader.callTool({ name, arguments: args });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("may not");
    };
    await denied("read", { path: "projects/secret/plan.md" });
    await denied("history", { path: "projects/secret/plan.md" });
    await denied("list", { path: "projects/secret" });
    await denied("start", { path: "projects/secret" });
    await denied("write", { path: "shared/new.md", content: "# x\n", why: "w" });
    await denied("edit", { path: "shared/stack.md", old: "", new: "more", why: "w" });
    await denied("delete", { path: "shared/stack.md", why: "w" });

    // Its own folder is writable.
    const ok = await reader.callTool({ name: "write", arguments: { path: "agents/reader/notes.md", content: "# Notes\n", why: "w" } });
    expect(ok.isError).toBeFalsy();

    // Search and list only show what the key may read.
    const s = JSON.parse(text(await reader.callTool({ name: "search", arguments: { query: "zebra" } })));
    expect(s.results).toEqual([]);
    const root = JSON.parse(text(await reader.callTool({ name: "list", arguments: {} })));
    expect(root.entries.map((e: any) => e.path).sort()).toEqual(["agents/", "shared/"]);
    // start skips the root profile, which the key may not read.
    const start = text(await reader.callTool({ name: "start", arguments: { path: "shared" } }));
    expect(start).toContain("## shared/profile.md");
    expect(start).not.toContain("Root facts");

  });

  test("every call logs an event, and the stream pushes them live", async () => {
    const res = await fetch(`${app.url}/api/events/stream?token=${ADMIN_TOKEN}`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader2 = res.body!.getReader();
    let received = "";
    const reading = (async () => {
      while (!received.includes('"action":"search"')) {
        const { value, done } = await reader2.read();
        if (done) break;
        received += new TextDecoder().decode(value);
      }
    })();
    await reader.callTool({ name: "search", arguments: { query: "streamed" } });
    await until(() => received.includes('"action":"search"'));
    reader2.cancel();
    await reading.catch(() => {});

    const { events } = await (await api("/api/events?agent=reader&limit=50")).json();
    expect(events[0]).toMatchObject({ agent: "reader", action: "search", query: "streamed", ok: true });
    expect(events.some((e: any) => e.action === "read" && e.ok === false && e.path === "projects/secret/plan.md")).toBe(true);
    const newer = await (await api(`/api/events?after=${events[1].id}`)).json();
    expect(newer.events.map((e: any) => e.id)).toEqual([events[0].id]);
  });

  test("the dashboard API", async () => {
    expect((await fetch(app.url + "/api/health")).status).toBe(401);
    const health = await (await api("/api/health")).json();
    expect(health).toMatchObject({ ok: true, db: backend, version: "dev", embed: { model: "test/words", loaded: true } });

    const tree = await (await api("/api/tree?path=shared")).json();
    expect(tree.path).toBe("shared/");
    expect(tree.entries.find((e: any) => e.name === "stack.md")).toMatchObject({ type: "file", path: "shared/stack.md" });

    const file = await (await api("/api/file?path=shared/stack.md")).json();
    expect(Object.keys(file).sort()).toEqual(["bytes", "content", "path", "summary", "title", "updatedAt", "version"]);
    expect(file.title).toBe("Stack");

    const { versions } = await (await api("/api/history?path=shared/stack.md")).json();
    const { diff } = await (await api(`/api/diff?path=shared/stack.md&from=${versions[1].commit}&to=${versions[0].commit}`)).json();
    expect(diff).toContain("+We deploy with Docker Compose.");

    const restore = await api("/api/restore", { method: "POST", body: JSON.stringify({ path: "shared/stack.md", commit: versions[1].commit }) });
    expect((await restore.json()).version).toBe(versions[1].version);
    const after = await (await api("/api/history?path=shared/stack.md&limit=1")).json();
    expect(after.versions[0].agent).toBe("admin");

    const search = await (await api("/api/search?q=kamal")).json();
    expect(search).toMatchObject({ meaning: "ok", results: [{ path: "shared/stack.md" }] });

    const created = await api("/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "dash", grants: [{ prefix: "projects/shop", mode: "write" }] }),
    });
    const { agent, key } = await created.json();
    expect(key).toMatch(/^sk_/);
    expect(agent.grants).toEqual([{ prefix: "projects/shop/", mode: "write" }]);
    const patched = await (
      await api(`/api/agents/${agent.id}`, { method: "PATCH", body: JSON.stringify({ grants: [{ prefix: "shared/", mode: "read" }] }) })
    ).json();
    expect(patched.agent.grants).toEqual([{ prefix: "shared/", mode: "read" }]);
    const { agents } = await (await api("/api/agents")).json();
    const reader = agents.find((a: any) => a.name === "reader");
    expect(reader.lastSeenAt).toBeTruthy();
    expect(reader).not.toHaveProperty("keyHash");
    expect(JSON.stringify(agents)).not.toContain(readerKey);

    const bad = await api("/api/file?path=../etc/passwd");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "bad_path" } });
    expect((await api("/api/nope")).status).toBe(404);
  });
});
