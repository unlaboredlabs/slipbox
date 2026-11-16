// The command line, run as a subprocess: zero-config first run, keys, reindex.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ADMIN } from "../access";
import { openStore } from "../db";
import { NAME } from "../name";
import { type Env, backend, makeEnv, openMemory } from "./helpers";

const CLI = join(import.meta.dir, "..", "cli.ts");

describe(`cli (${backend})`, () => {
  let env: Env;
  let vars: Record<string, string>;

  beforeEach(async () => {
    env = await makeEnv();
    vars = {
      CONFIG_FILE: join(env.dir, "config", "config.env"),
      DATA_DIR: env.dataDir,
      DATABASE_URL: env.dbUrl,
      EMBED_MODEL: "off",
      PORT: "1", // nothing listens there, so the CLI sees no running server
    };
  });
  afterEach(() => env.cleanup());

  async function cli(...args: string[]) {
    const proc = Bun.spawn(["bun", CLI, ...args], { env: { ...process.env, ...vars, ADMIN_TOKEN: "" }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { out: out + err, code };
  }

  test("first run creates a config with an admin token", async () => {
    const r = await cli("key", "list");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Created");
    expect(readFileSync(vars.CONFIG_FILE, "utf8")).toMatch(/^ADMIN_TOKEN=[\w-]{40,}$/m);
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
    expect(list.out).toContain("read /, write projects/shop/");
    expect(list.out).not.toContain(key!);

    expect((await cli("key", "revoke", "claude")).out).toContain("Revoked claude");
    expect((await cli("key", "list")).out).toContain("revoked");
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
  });
});
