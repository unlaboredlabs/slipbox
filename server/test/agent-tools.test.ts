// What agents see from the MCP tools: profiles, map size, hints and error text.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createAgent } from "../access";
import type { Config } from "../config";
import { startServer } from "../index";
import { MAP_ENTRIES } from "../mcp";
import { type Env, WordsEmbedder, backend, makeEnv } from "./helpers";

const text = (r: any): string => r.content[0].text;

describe(`agent tools (${backend})`, () => {
  let env: Env;
  let app: Awaited<ReturnType<typeof startServer>>;
  let agent: Client;

  beforeAll(async () => {
    env = await makeEnv();
    // Written before the server starts, which indexes and commits them in one go.
    const notes: Record<string, string> = {
      "shared/profile.md": "# Shared\n\nEvery agent squash merges.\n",
      "projects/shop/profile.md": "# Shop\n\nThe shop runs Prisma 6.\n",
    };
    for (let i = 0; i < MAP_ENTRIES + 30; i++) notes[`agents/claude/n${String(i).padStart(4, "0")}.md`] = `# Note ${i}\n\nOne line.\n`;
    for (const [path, content] of Object.entries(notes)) {
      mkdirSync(dirname(join(env.dataDir, path)), { recursive: true });
      writeFileSync(join(env.dataDir, path), content);
    }
    const config: Config = {
      dataDir: env.dataDir,
      databaseUrl: env.dbUrl,
      adminToken: "test-admin-token",
      host: "127.0.0.1",
      port: 0,
      maxFileBytes: 32 * 1024,
      embedModel: "test/words",
      modelsDir: env.dir,
      configFile: "",
      serviceName: "",
    };
    app = await startServer(config, { embedder: new WordsEmbedder() });
    const { key } = await createAgent(app.store, "claude", [
      { prefix: "shared/", mode: "read" },
      { prefix: "projects/shop/", mode: "read" },
      { prefix: "agents/claude/", mode: "write" },
    ]);
    agent = new Client({ name: "test", version: "1" });
    await agent.connect(
      new StreamableHTTPClientTransport(new URL(app.url + "/mcp"), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }),
    );
  });

  afterAll(async () => {
    await agent?.close();
    await app?.stop();
    await env.cleanup();
  });

  test("start always loads shared/profile.md, before the profiles down the path", async () => {
    const shop = text(await agent.callTool({ name: "start", arguments: { path: "projects/shop" } }));
    expect(shop).toContain("## shared/profile.md\n\n# Shared");
    expect(shop.indexOf("## shared/profile.md")).toBeLessThan(shop.indexOf("## projects/shop/profile.md"));
    expect(text(await agent.callTool({ name: "start", arguments: {} }))).toContain("## shared/profile.md");
    // Once, when the path is under shared/ itself.
    const shared = text(await agent.callTool({ name: "start", arguments: { path: "shared" } }));
    expect(shared.split("## shared/profile.md").length).toBe(2);
  });

  test("start and list show at most MAP_ENTRIES entries of a big folder, and say how many more there are", async () => {
    const start = text(await agent.callTool({ name: "start", arguments: { path: "agents/claude" } }));
    expect(start).toContain("30 more entries are not shown: list a subfolder, or search.");
    expect(start).not.toContain("n0229.md");
    const list = JSON.parse(text(await agent.callTool({ name: "list", arguments: { path: "agents/claude" } })));
    expect(list.entries.length).toBe(MAP_ENTRIES);
    expect(list.more).toContain("30 more entries");
    // Compact: about 160 characters an entry, not a pretty-printed 200.
    expect(start.length).toBeLessThan(MAP_ENTRIES * 170 + 1000);
  });

  test("every tool describes its parameters, and says whether it only reads", async () => {
    const { tools } = await agent.listTools();
    for (const t of tools) {
      for (const [name, p] of Object.entries(t.inputSchema.properties ?? {})) {
        expect({ tool: t.name, name, described: !!(p as any).description }).toEqual({ tool: t.name, name, described: true });
      }
    }
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort();
    expect(readOnly).toEqual(["history", "list", "read", "search", "start"]);
    expect(tools.find((t) => t.name === "delete")?.annotations?.destructiveHint).toBe(true);
  });

  test("a query with no letters or digits is refused, not answered with meaning matches", async () => {
    const r = await agent.callTool({ name: "search", arguments: { query: "?!" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("query has no words: search for letters or digits.");
  });

  test("an internal error tells the agent nothing of the server, and logs the details", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    const history = spyOn(app.memory.git, "history").mockRejectedValue(new Error(`ENOENT: ${env.dataDir}/.git/secret`));
    try {
      const r = await agent.callTool({ name: "history", arguments: { path: "shared/profile.md" } });
      expect(r.isError).toBe(true);
      expect(text(r)).toBe("Internal error; the server log has the details.");
      expect(String(logged.mock.calls[0]?.[0])).toContain(".git/secret");
    } finally {
      history.mockRestore();
      logged.mockRestore();
    }
  });
});
