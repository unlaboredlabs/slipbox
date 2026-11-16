// Keys are managed from the CLI while the server runs: that must work even
// while the server is busy indexing and embedding (on SQLite, two processes
// share one database file).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config";
import { startServer } from "../index";
import { type Env, MODELS_DIR, backend, makeEnv } from "./helpers";

const CLI = join(import.meta.dir, "..", "cli.ts");
const NOTES = 300;

describe(`CLI against a busy server (${backend})`, () => {
  let env: Env;
  let app: Awaited<ReturnType<typeof startServer>> | undefined;

  beforeAll(async () => {
    env = await makeEnv();
    for (let i = 0; i < NOTES; i++) {
      const dir = join(env.dataDir, "projects", `p${i % 10}`);
      mkdirSync(dir, { recursive: true });
      const body = Array.from({ length: 4 }, (_, j) => `## Part ${j}\n\nNote ${i} part ${j} talks about topic ${(i * 7 + j) % 23}.`);
      writeFileSync(join(dir, `n${i}.md`), `# Note ${i}\n\nSummary of note ${i}.\n\n${body.join("\n\n")}\n`);
    }
    // Share the test model cache, so the server really embeds (and is busy doing so).
    mkdirSync(MODELS_DIR, { recursive: true });
    symlinkSync(MODELS_DIR, join(env.dir, "models"));
  });

  afterAll(async () => {
    await app?.stop();
    await env.cleanup();
  });

  test("key create, list and revoke while the server reconciles and embeds", async () => {
    const config: Config = {
      dataDir: env.dataDir,
      databaseUrl: env.dbUrl,
      adminToken: "busy-token",
      host: "127.0.0.1",
      port: 0,
      maxFileBytes: 32 * 1024,
      embedModel: "Xenova/bge-small-en-v1.5",
      modelsDir: join(env.dir, "models"),
      configFile: "",
      serviceName: "",
    };
    // Not awaited: the CLI runs while the server is still reconciling 300 files.
    const starting = startServer(config).then((a) => (app = a));

    const vars = {
      ...process.env,
      SLIPBOX_CONFIG_FILE: join(env.dir, "config.env"),
      SLIPBOX_DATA_DIR: env.dataDir,
      SLIPBOX_DATABASE_URL: env.dbUrl,
      SLIPBOX_ADMIN_TOKEN: "busy-token",
      SLIPBOX_PORT: "1",
    };
    const cli = async (...args: string[]) => {
      const proc = Bun.spawn(["bun", CLI, ...args], { env: vars, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      if (code !== 0) throw new Error(`key ${args.join(" ")} failed: ${out}${err}`);
      return out;
    };

    let sawEmbedding = false;
    for (let round = 0; round < 6; round++) {
      await cli("key", "create", `agent-${round}`, "--write", "/");
      expect(await cli("key", "list")).toContain(`agent-${round}`);
      await cli("key", "revoke", `agent-${round}`);
      const s = app?.memory.embeddings.status();
      if (s && s.loaded && s.queued > 0) sawEmbedding = true;
    }
    await starting;
    const s = app!.memory.embeddings.status();
    // The server indexed everything, and the keys were managed while it was busy.
    expect(s.total).toBe(NOTES * 5);
    expect(sawEmbedding || s.queued > 0).toBe(true);
    expect((await app!.store.listAgents()).filter((a) => a.revoked).length).toBe(6);
  }, 120_000);
});
