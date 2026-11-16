// Notes stay safe: crashes, failed writes, races with the watcher, odd files and
// links in the data folder, and the limits that keep the service from stalling.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Caller, createAgent } from "../access";
import { openStore } from "../db";
import { versionOf } from "../files";
import { type Env, backend, makeEnv, openMemory, until } from "./helpers";

const writer: Caller = { name: "ada", grants: [{ prefix: "", mode: "write" }] };
const shop: Caller = { name: "shop", grants: [{ prefix: "projects/shop/", mode: "write" }, { prefix: "shared/", mode: "read" }] };

describe(`notes stay safe (${backend})`, () => {
  let env: Env;
  let m: Awaited<ReturnType<typeof openMemory>>;
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: env.dataDir }).stdout.toString().trim();

  beforeEach(async () => {
    env = await makeEnv();
    m = await openMemory(env);
  });
  afterEach(async () => {
    await m.close();
    await env.cleanup();
  });

  test("git lock files left by a crash are cleared at start", async () => {
    await m.memory.write(writer, "shared/a.md", "# A\n\none\n", "create");
    await m.close();
    const dotGit = join(env.dataDir, ".git");
    for (const f of ["index.lock", "HEAD.lock", "next-index-4242.lock", "refs/heads/main.lock"]) writeFileSync(join(dotGit, f), "");
    m = await openMemory(env);
    const r = await m.memory.edit(writer, "shared/a.md", "", "two\n", "after a crash");
    expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(readdirSync(dotGit).filter((f) => f.endsWith(".lock"))).toEqual([]);
  });

  test("a write replaces the file whole, never in place", async () => {
    await m.memory.write(writer, "shared/a.md", "# A\n\none\n", "create");
    // A second name for the old file: a write in place would change it too.
    const old = join(env.dir, "old-a.md");
    linkSync(join(env.dataDir, "shared/a.md"), old);
    const { version } = await m.memory.read(writer, "shared/a.md");
    await m.memory.write(writer, "shared/a.md", "# A\n\ntwo\n", "replace", version);
    expect(readFileSync(old, "utf8")).toBe("# A\n\none\n");
    expect(readFileSync(join(env.dataDir, "shared/a.md"), "utf8")).toBe("# A\n\ntwo\n");
    expect(readdirSync(join(env.dataDir, "shared"))).toEqual(["a.md"]); // no temporary file left
  });

  test("a write that fails part way leaves the old version, on disk and in git", async () => {
    await m.memory.write(writer, "shared/big.md", "# Big\n\n" + "A".repeat(1000) + "\n", "create");
    const { version } = await m.memory.read(writer, "shared/big.md");
    const files = m.memory.files;
    const realWrite = files.write.bind(files);
    let calls = 0;
    files.write = async (path, content) => {
      if (calls++ === 0) {
        await realWrite(path, content.slice(0, 20)); // as a full disk would leave it
        throw new Error("ENOSPC: no space left on device");
      }
      return realWrite(path, content);
    };
    await expect(m.memory.write(writer, "shared/big.md", "# Big\n\n" + "B".repeat(2000) + "\n", "disk full", version)).rejects.toThrow(
      "ENOSPC",
    );
    files.write = realWrite;
    expect(readFileSync(join(env.dataDir, "shared/big.md"), "utf8")).toBe("# Big\n\n" + "A".repeat(1000) + "\n");
    expect(git("status", "--porcelain")).toBe("");
  });

  test("writes never fail on git's index lock while the watcher checks for outside changes", async () => {
    await m.close();
    m = await openMemory(env, undefined, { watch: true });
    const failed: string[] = [];
    for (let i = 0; i < 80; i++) {
      await m.memory.write(writer, `agents/ada/n${i}.md`, `# N${i}\n\nnote ${i}\n`, `note ${i}`).catch((e) => failed.push(e.message));
    }
    expect(failed).toEqual([]);
  }, 20_000);

  test("the watcher never takes an agent's write into an outside commit", async () => {
    await m.close();
    m = await openMemory(env, undefined, { watch: true });
    const results: { path: string; commit: string | null }[] = [];
    await Promise.all([
      // Each new folder is a folder event for the watcher.
      (async () => {
        for (let i = 0; i < 40; i++) results.push(await m.memory.write(writer, `projects/p${i}/b.md`, `# B${i}\n\nb\n`, `b ${i}`));
      })(),
      (async () => {
        for (let i = 0; i < 40; i++) results.push(await m.memory.write(writer, `shared/a${i}.md`, `# A${i}\n\na\n`, `a ${i}`));
      })(),
    ]);
    await Bun.sleep(400); // let the watcher catch up
    expect(results.filter((r) => !r.commit)).toEqual([]);
    expect(git("log", "--author=outside", "--format=%s")).toBe("");
  }, 20_000);

  test("a new folder reconciles that folder, not every file", async () => {
    await m.close();
    m = await openMemory(env, undefined, { watch: true });
    // macOS's file events can miss a change made the moment the watcher starts: wait until it sees one.
    const committed = async (path: string) =>
      (await m.memory.history(writer, path).catch(() => ({ versions: [] }))).versions.length > 0;
    for (let i = 0; !(await committed("live.md")); i++) {
      writeFileSync(join(env.dataDir, "live.md"), `# Live\n\nthe watcher is on (${i})\n`);
      await until(() => committed("live.md"), 1000).catch(() => {});
      if (i > 10) throw new Error("the watcher never saw a change");
    }
    const files = m.memory.files;
    const realAll = files.allFiles.bind(files);
    const scanned: string[] = [];
    files.allFiles = (dir = "") => {
      scanned.push(dir);
      return realAll(dir);
    };
    mkdirSync(join(env.dataDir, "projects/new"), { recursive: true });
    writeFileSync(join(env.dataDir, "projects/new/n.md"), "# New\n\nwatched folder\n");
    await until(() => committed("projects/new/n.md"), 10_000);
    expect(scanned).not.toContain("");
  });

  test("a committed write is reported ok when the index update fails", async () => {
    const store = m.store;
    const realPut = store.putDoc.bind(store);
    store.putDoc = async () => {
      throw new Error("connection lost");
    };
    const r = await m.memory.write(writer, "shared/x.md", "# X\n\nindexed later\n", "index fails");
    store.putDoc = realPut;
    expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
    await m.close();
    m = await openMemory(env);
    expect((await m.memory.search(writer, "indexed later")).results[0]?.path).toBe("shared/x.md");
  });

  test("a note that is not UTF-8 is never rewritten", async () => {
    const bytes = Buffer.from([0x23, 0x20, 0x43, 0x61, 0x66, 0xe9, 0x0a]); // "# Café" in Latin-1
    mkdirSync(join(env.dataDir, "shared"), { recursive: true });
    writeFileSync(join(env.dataDir, "shared/latin1.md"), bytes);
    await m.close();
    m = await openMemory(env);
    await expect(m.memory.edit(writer, "shared/latin1.md", "", "more\n", "append")).rejects.toMatchObject({ code: "not_text" });
    await expect(m.memory.read(writer, "shared/latin1.md")).rejects.toMatchObject({ code: "not_text" });
    expect(readFileSync(join(env.dataDir, "shared/latin1.md"))).toEqual(bytes);
    // Indexed as empty, under the hash git knows it by.
    expect((await m.store.getDoc("shared/latin1.md"))?.hash).toBe(versionOf(bytes));
    // A byte order mark is kept, so the version stays the git blob id.
    writeFileSync(join(env.dataDir, "shared/bom.md"), "﻿# Bom\n\nx\n");
    const bom = await m.memory.read(writer, "shared/bom.md");
    expect(bom.version).toBe(versionOf(readFileSync(join(env.dataDir, "shared/bom.md"))));
  });

  test("history keeps notes only, not stray files", async () => {
    await m.close();
    mkdirSync(join(env.dataDir, "shared"), { recursive: true });
    writeFileSync(join(env.dataDir, "notes.txt"), "not a note");
    writeFileSync(join(env.dataDir, "shared/.a.md.swp"), "swap");
    writeFileSync(join(env.dataDir, "shared/a.md"), "# A\n\nx\n");
    m = await openMemory(env);
    expect(git("ls-files")).toBe("shared/a.md");
  });

  test("a symlink inside the data folder cannot get around grants", async () => {
    await m.memory.write(writer, "projects/shop-secret/s.md", "# Secret\n\nThe password is hunter2.\n", "secret");
    await m.memory.write(writer, "projects/shop/a.md", "# Shop\n\nPublic note.\n", "public");
    await m.close();
    symlinkSync("../shop-secret/s.md", join(env.dataDir, "projects/shop/link.md"));
    symlinkSync("../shop-secret", join(env.dataDir, "projects/shop/dirlink"));
    m = await openMemory(env);
    for (const p of ["projects/shop/link.md", "projects/shop/dirlink/s.md"]) {
      await expect(m.memory.read(shop, p)).rejects.toMatchObject({ code: "bad_path" });
      await expect(m.memory.write(shop, p, "# x\n", "t")).rejects.toMatchObject({ code: "bad_path" });
      await expect(m.memory.edit(shop, p, "hunter2", "OVERWRITTEN", "t")).rejects.toMatchObject({ code: "bad_path" });
    }
    expect((await m.memory.list(shop, "projects/shop")).entries.map((e) => e.path)).toEqual(["projects/shop/a.md"]);
    expect((await m.memory.search(shop, "hunter2")).results).toEqual([]);
    expect((await m.memory.search(writer, "hunter2")).results.map((r) => r.path)).toEqual(["projects/shop-secret/s.md"]);
    expect(readFileSync(join(env.dataDir, "projects/shop-secret/s.md"), "utf8")).toContain("hunter2");
  });

  test("links leading outside or nowhere never stop the start, and the folder still works", async () => {
    await m.close();
    mkdirSync(join(env.dataDir, "shared"), { recursive: true });
    writeFileSync(join(env.dir, "outside.md"), "# Outside\n");
    symlinkSync(join(env.dir, "outside.md"), join(env.dataDir, "shared/out.md"));
    symlinkSync("does-not-exist", join(env.dataDir, "shared/dangle"));
    writeFileSync(join(env.dataDir, "shared/real.md"), "# Real\n\nreal note\n");
    m = await openMemory(env);
    expect((await m.memory.list(writer, "shared")).entries.map((e) => e.path)).toEqual(["shared/real.md"]);
    expect((await m.memory.search(writer, "real note")).results[0]?.path).toBe("shared/real.md");
  });

  test("closing waits for writes in flight to commit", async () => {
    const writes = Array.from({ length: 10 }, (_, i) => m.memory.write(writer, `shared/w${i}.md`, `# W${i}\n\nx\n`, `w ${i}`));
    await m.memory.close();
    // Checked before awaiting the writes: a process exits right after close.
    expect(git("ls-files").split("\n")).toHaveLength(10);
    expect(git("status", "--porcelain")).toBe("");
    expect((await Promise.all(writes)).every((w) => w.commit)).toBe(true);
  });

  test("the activity log keeps paths and queries short, and refuses huge queries", async () => {
    await expect(m.memory.search(writer, "zebra ".repeat(200_000))).rejects.toMatchObject({ code: "bad_query" });
    const e = await m.memory.events.log({ agent: "ada", action: "search", path: "x".repeat(10_000), query: "y".repeat(1_000_000), ok: false });
    expect(e!.path!.length).toBeLessThanOrEqual(501);
    expect(e!.query!.length).toBeLessThanOrEqual(501);
    const [stored] = await m.store.events({ limit: 1 });
    expect(stored.query!.length).toBeLessThanOrEqual(501);
  });

  test("old events are dropped, the newest kept", async () => {
    for (let i = 0; i < 30; i++) await m.memory.events.log({ agent: "ada", action: "read", path: `shared/n${i}.md`, query: null, ok: true });
    await m.memory.events.prune(10);
    const left = await m.store.events({ limit: 100 });
    expect(left.map((e) => e.path)).toEqual(Array.from({ length: 10 }, (_, i) => `shared/n${29 - i}.md`));
  });

  test("notes and the database are for this user only", async () => {
    expect(statSync(env.dataDir).mode & 0o777).toBe(0o700);
    if (backend === "sqlite") expect(statSync(env.dbUrl).mode & 0o777).toBe(0o600);
  });

  test("a damaged database names the file and the way out", async () => {
    if (backend !== "sqlite") return;
    await m.close();
    writeFileSync(env.dbUrl, "this is not a database".repeat(1000));
    await expect(openStore(env.dbUrl)).rejects.toThrow(/move it aside.*keys must be created again/);
    m = { memory: { close: async () => {} }, store: null, close: async () => {} } as any;
  });

  test("path rules: long names and folders named like notes are refused", async () => {
    for (const bad of [`shared/${"a".repeat(101)}.md`, `${"abcdefghij/".repeat(52)}x.md`, "shared/x.md/y.md"]) {
      await expect(m.memory.write(writer, bad, "# x\n", "t")).rejects.toMatchObject({ code: "bad_path" });
    }
    await m.memory.write(writer, `shared/${"a".repeat(97)}.md`, "# ok\n", "fits");
  });

  test("errors say what to do next", async () => {
    await m.memory.write(writer, "shared/a.md", "# A\n\none\ntwo\n", "create");
    await expect(m.memory.read(writer, "shared/a.md", { lines: "10-20" })).rejects.toMatchObject({
      code: "bad_lines",
      message: expect.stringContaining("has 4 lines"),
    });
    await expect(m.memory.read(writer, "shared/a.md", { lines: "3-1" })).rejects.toMatchObject({ code: "bad_lines" });
    await expect(m.memory.write(writer, "shared/a.md", "# A\n", "t", "abc")).rejects.toMatchObject({
      code: "bad_version",
      message: expect.stringContaining("too short"),
    });
    await expect(m.memory.history(writer, "shared/none.md")).rejects.toMatchObject({ code: "not_found" });
    await expect(m.memory.search(shop, "x", "projects/shop-secret")).rejects.toMatchObject({ code: "forbidden" });
    await expect(m.memory.write(shop, "shared/a.md", "# A\n", "t")).rejects.toMatchObject({
      code: "forbidden",
      message: expect.stringContaining("It may write: projects/shop/."),
    });
  });

  test("agent names: reserved ones and ones differing only in case are refused", async () => {
    for (const name of ["admin", "Outside"]) {
      await expect(createAgent(m.store, name, [])).rejects.toMatchObject({ code: "bad_name" });
    }
    await createAgent(m.store, "claude", []);
    await expect(createAgent(m.store, "Claude", [])).rejects.toMatchObject({ code: "exists" });
  });
});
