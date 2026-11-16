// The command line, run as a subprocess: zero-config first run, keys, reindex,
// the data folder's lock, settings and arguments.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADMIN } from "../access";
import { openStore } from "../db";
import { lockFile } from "../lock";
import { NAME } from "../name";
import { type Env, backend, makeEnv, openMemory, until } from "./helpers";

const CLI = join(import.meta.dir, "..", "cli.ts");

describe(`cli (${backend})`, () => {
  let env: Env;
  let vars: Record<string, string>;
  const spawned: Bun.Subprocess[] = [];

  beforeEach(async () => {
    env = await makeEnv();
    vars = {
      SLIPBOX_CONFIG_FILE: join(env.dir, "config", "config.env"),
      SLIPBOX_DATA_DIR: env.dataDir,
      SLIPBOX_DATABASE_URL: env.dbUrl,
      SLIPBOX_EMBED_MODEL: "off",
      SLIPBOX_PORT: "1", // nothing listens there, so the CLI sees no running server
    };
  });
  afterEach(async () => {
    for (const p of spawned.splice(0)) {
      p.kill(9);
      await p.exited;
    }
    await env.cleanup();
  });

  const run = (args: string[], extra: Record<string, string> = {}) =>
    Bun.spawn(["bun", CLI, ...args], { env: { ...process.env, ...vars, SLIPBOX_ADMIN_TOKEN: "", ...extra }, stdout: "pipe", stderr: "pipe" });

  async function cli(...args: string[]) {
    const proc = run(args);
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { out: out + err, code };
  }

  /** Starts `serve` on a free port and waits until it listens. */
  async function serve() {
    const proc = run(["serve"], { SLIPBOX_PORT: "0" });
    spawned.push(proc);
    const reader = proc.stdout.getReader();
    let out = "";
    while (!/listening on (\S+)/.test(out)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`serve exited: ${out}${await new Response(proc.stderr).text()}`);
      out += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    return { proc, url: /listening on (\S+)/.exec(out)![1] };
  }

  test("first run creates a config with an admin token", async () => {
    const r = await cli("key", "list");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Created");
    expect(readFileSync(vars.SLIPBOX_CONFIG_FILE, "utf8")).toMatch(/^ADMIN_TOKEN=[\w-]{40,}$/m);
  });

  test("status and unknown commands create no config, and status fails while nothing runs", async () => {
    const status = await cli("status");
    expect(status.code).toBe(1);
    expect(status.out).toContain("server:   not running at http://127.0.0.1:1");
    expect((await cli("bogus")).code).toBe(1);
    expect(existsSync(vars.SLIPBOX_CONFIG_FILE)).toBe(false);
  });

  test("key create, list and revoke", async () => {
    const created = await cli("key", "create", "claude", "--write", "projects/shop", "--read", "/");
    expect(created.code).toBe(0);
    const key = /Key \(shown once\): (sk_\S+)/.exec(created.out)?.[1];
    expect(key).toBeTruthy();
    expect(created.out).toContain(`claude mcp add --transport http ${NAME}`);
    expect((await cli("key", "create", "claude", "--read", "/")).code).toBe(1);
    expect((await cli("key", "create", "nogrants")).out).toContain("at least one --read or --write");

    const list = await cli("key", "list");
    expect(list.out).toContain("claude");
    expect(list.out).toMatch(/never used +read \/, write projects\/shop\/$/m); // grants last, so long ones keep the columns
    expect(list.out).not.toContain(key!);

    expect((await cli("key", "revoke", "claude")).out).toContain("Revoked claude");
    expect((await cli("key", "list")).out).toContain("revoked");
  });

  test("key create refuses an empty prefix, which would mean everything", async () => {
    const r = await cli("key", "create", "z", "--write", "");
    expect(r.code).toBe(1);
    expect(r.out).toContain("A prefix is empty");
    expect((await cli("key", "list")).out).toContain("No keys yet");
  });

  test("reindex rebuilds the index from the files", async () => {
    const m = await openMemory(env, null);
    await m.memory.write(ADMIN, "shared/a.md", "# A\n\nquartz\n", "create");
    await m.memory.write(ADMIN, "projects/x/b.md", "# B\n\nember\n\n## More\n\nmaple\n", "create");
    await m.store.resetIndex(); // the index is gone, the files are not
    expect(await m.store.counts()).toEqual({ docs: 0, sections: 0 });
    await m.close();

    const r = await cli("reindex");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Word index rebuilt: 2 files, 3 sections.");
    const store = await openStore(env.dbUrl);
    expect(await store.counts()).toEqual({ docs: 2, sections: 3 });
    await store.close();
    expect(existsSync(lockFile(env.dataDir))).toBe(false);
  });

  test("settings come from the environment only as SLIPBOX_*, so another app's DATABASE_URL is never touched", async () => {
    const other = join(env.dir, "other.db");
    const db = new Database(other);
    db.run("create table docs (id integer primary key, body text)");
    db.run("insert into docs (body) values ('my app data')");
    db.close();
    const proc = Bun.spawn(["bun", CLI, "reindex"], {
      env: { ...process.env, ...vars, DATABASE_URL: other, DATA_DIR: join(env.dir, "elsewhere"), PORT: "9" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
    const after = new Database(other);
    expect(after.query("select body from docs").all()).toEqual([{ body: "my app data" }]);
    after.close();
    expect(existsSync(join(env.dir, "elsewhere"))).toBe(false);
  });

  test("a second server or reindex on a data folder in use is refused; the lock survives no kill -9", async () => {
    const first = await serve();
    expect(readFileSync(lockFile(env.dataDir), "utf8").trim()).toBe(String(first.proc.pid));

    const second = await cli("serve"); // another port, same data folder
    expect(second.code).toBe(1);
    expect(second.out).toContain(`already running on ${env.dataDir} (pid ${first.proc.pid})`);
    const reindex = await cli("reindex");
    expect(reindex.code).toBe(1);
    expect(reindex.out).toContain("already running");

    first.proc.kill(9);
    await first.proc.exited;
    expect(existsSync(lockFile(env.dataDir))).toBe(true); // left by the killed server
    const after = await cli("reindex");
    expect(after.out).toContain("Word index rebuilt");
    expect(after.code).toBe(0);
    expect(existsSync(lockFile(env.dataDir))).toBe(false);

    // A stopped server leaves no lock behind.
    const again = await serve();
    again.proc.kill("SIGTERM");
    expect(await again.proc.exited).toBe(0);
    expect(existsSync(lockFile(env.dataDir))).toBe(false);
  }, 30_000);

  test("an IPv6 host is bracketed in the URLs the CLI uses", async () => {
    const r = Bun.spawn(["bun", CLI, "status"], { env: { ...process.env, ...vars, SLIPBOX_HOST: "::1" }, stdout: "pipe" });
    expect(await new Response(r.stdout).text()).toContain("not running at http://[::1]:1");
  });

  test("commands refuse unknown arguments and show help for --help without running", async () => {
    const m = await openMemory(env, null);
    await m.memory.write(ADMIN, "shared/a.md", "# A\n\nquartz\n", "create");
    await m.close();
    const help = await cli("reindex", "--help");
    expect(help.code).toBe(0);
    expect(help.out).toContain("Usage:");
    expect(help.out).not.toContain("rebuilt");
    expect((await cli("status", "--nope")).code).toBe(1);
    expect((await cli("serve", "extra")).out).toContain('Unexpected argument "extra"');
    const svc = await cli("service", "uninstall", "--help");
    expect(svc.code).toBe(0);
    expect(svc.out).toContain("Usage:");
    expect((await cli("key", "revoke")).out).toContain("Give the key's name");
  });

  test("bad settings are refused with their name and where they came from", async () => {
    mkdirSync(join(env.dir, "config"), { recursive: true });
    writeFileSync(vars.SLIPBOX_CONFIG_FILE, "ADMIN_TOKEN=x\nMAX_FILE_BYTES=32k\n");
    const size = await cli("status");
    expect(size.code).toBe(1);
    expect(size.out).toContain(`MAX_FILE_BYTES in ${vars.SLIPBOX_CONFIG_FILE} must be a whole number`);

    writeFileSync(vars.SLIPBOX_CONFIG_FILE, "ADMIN_TOKEN=x\n");
    const port = Bun.spawn(["bun", CLI, "status"], { env: { ...process.env, ...vars, SLIPBOX_PORT: "abc" }, stderr: "pipe" });
    expect(await new Response(port.stderr).text()).toContain('SLIPBOX_PORT must be a whole number from 0 to 65535, not "abc"');

    writeFileSync(vars.SLIPBOX_CONFIG_FILE, "ADMIN_TOKEN=\n");
    const empty = await cli("serve");
    expect(empty.code).toBe(1);
    expect(empty.out).toContain("ADMIN_TOKEN is empty");
  });

  test("service install refuses settings from the environment, which the service would not see", async () => {
    const r = await cli("service", "install");
    expect(r.code).toBe(1);
    expect(r.out).toContain("The service reads its settings from");
    expect(r.out).toContain("Put DATA_DIR, DATABASE_URL, PORT, EMBED_MODEL there");
  });
});

describe("server shutdown", () => {
  test("a stop lets writes in flight finish and commit", async () => {
    const env = await makeEnv();
    const { startServer } = await import("../index");
    const { createAgent } = await import("../access");
    const app = await startServer(
      {
        dataDir: env.dataDir,
        databaseUrl: env.dbUrl,
        adminToken: "t",
        host: "127.0.0.1",
        port: 0,
        maxFileBytes: 32 * 1024,
        embedModel: "off",
        modelsDir: join(env.dir, "models"),
        configFile: "",
        serviceName: "",
      },
      { embedder: null },
    );
    const { key } = await createAgent(app.store, "a1", [{ prefix: "", mode: "write" }]);
    const write = (i: number) =>
      fetch(`${app.url}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: i,
          method: "tools/call",
          params: { name: "write", arguments: { path: `shared/t${i}.md`, content: `# T${i}\n\nnote ${i}\n`, why: `w${i}` } },
        }),
      }).then(
        async (r) => r.status === 200 && !((await r.json()) as any).result?.isError,
        () => false,
      );
    const replies = Array.from({ length: 30 }, (_, i) => write(i));
    await until(() => existsSync(join(env.dataDir, "shared")), 5000);
    await app.stop();
    const ok = (await Promise.all(replies)).filter(Boolean).length;
    const git = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: env.dataDir }).stdout.toString().trim();
    expect(ok).toBeGreaterThan(0);
    expect(git("status", "--porcelain")).toBe(""); // nothing written without its commit
    expect(git("ls-files").split("\n").filter(Boolean).length).toBe(ok); // every ok reply is committed, and only those
    expect(existsSync(lockFile(env.dataDir))).toBe(false);
    await env.cleanup();
  }, 30_000);
});
