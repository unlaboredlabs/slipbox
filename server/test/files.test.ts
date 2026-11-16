import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADMIN, type Caller } from "../access";
import { versionOf } from "../files";
import { type Env, backend, makeEnv, openMemory, until } from "./helpers";

const writer: Caller = { name: "ada", grants: [{ prefix: "", mode: "write" }] };

describe(`files and history (${backend})`, () => {
  let env: Env;
  let m: Awaited<ReturnType<typeof openMemory>>;

  beforeEach(async () => {
    env = await makeEnv();
    m = await openMemory(env);
  });
  afterEach(async () => {
    await m.close();
    await env.cleanup();
  });

  test("refuses paths that escape or break the rules", async () => {
    for (const bad of ["../x.md", "/etc/passwd.md", "a/../../x.md", "shared/Notes.md", "shared/x.txt", "shared/.git.md", "a//b.md", ""]) {
      await expect(m.memory.write(writer, bad, "x", "test")).rejects.toMatchObject({ code: "bad_path" });
    }
    // A symlink pointing outside the data folder cannot be followed.
    const outside = join(env.dir, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(env.dataDir, "escape"));
    await expect(m.memory.write(writer, "escape/x.md", "x", "test")).rejects.toMatchObject({ code: "bad_path" });
    await expect(m.memory.read(writer, "escape/x.md")).rejects.toMatchObject({ code: "bad_path" });
  });

  test("refuses files over the size cap, and profiles over 4 KB", async () => {
    await expect(m.memory.write(writer, "shared/big.md", "x".repeat(32 * 1024 + 1), "test")).rejects.toMatchObject({
      code: "too_large",
      message: expect.stringContaining("Split it"),
    });
    await m.memory.write(writer, "shared/ok.md", "x".repeat(32 * 1024), "fits exactly");
    await expect(m.memory.write(writer, "shared/profile.md", "x".repeat(4097), "test")).rejects.toMatchObject({ code: "too_large" });
    // An edit that would grow a file past the cap is refused too.
    await expect(m.memory.edit(writer, "shared/ok.md", "", "more", "grow")).rejects.toMatchObject({ code: "too_large" });
  });

  test("replacing a file needs the current baseVersion", async () => {
    const first = await m.memory.write(writer, "shared/a.md", "# A\n\none\n", "create");
    // Without a base: the version and the note's outline, not its text.
    const exists = await m.memory.write(writer, "shared/a.md", "# A\n\ntwo\n", "no base").catch((e) => e);
    expect(exists).toMatchObject({ code: "exists", details: { version: first.version, outline: "# A\none\n3 lines:\n1-3 A" } });
    const second = await m.memory.write(writer, "shared/a.md", "# A\n\ntwo\n", "update", first.version!);
    expect(second.version).toBe(versionOf("# A\n\ntwo\n"));
    // A write based on the old version is refused, and gets the current text back.
    const err = await m.memory.write(writer, "shared/a.md", "# A\n\nthree\n", "late", first.version!).catch((e) => e);
    expect(err.code).toBe("stale");
    expect(err.details).toEqual({ version: second.version, content: "# A\n\ntwo\n" });
  });

  test("appending to a note that does not exist is refused: it would have no title", async () => {
    const err = await m.memory.edit(writer, "shared/new-log.md", "", "- first entry\n", "log").catch((e) => e);
    expect(err).toMatchObject({ code: "not_found" });
    expect(err.message).toContain("Create it with write");
    expect(m.memory.files.exists("shared/new-log.md")).toBe(false);
  });

  test("concurrent edits to one file are serialised: none are lost", async () => {
    await m.memory.write(writer, "shared/log.md", "# Log\n", "create");
    const lines = Array.from({ length: 20 }, (_, i) => `- entry ${i}`);
    await Promise.all(lines.map((l, i) => m.memory.edit({ name: `agent${i}`, grants: writer.grants }, "shared/log.md", "", l, `add ${i}`)));
    const { content } = await m.memory.read(writer, "shared/log.md");
    for (const l of lines) expect(content).toContain(l);
    const { versions } = await m.memory.history(writer, "shared/log.md", 100);
    expect(versions.length).toBe(21);
    // Concurrent full writes with the same base: exactly one wins, the rest are told they are stale.
    const base = (await m.memory.read(writer, "shared/log.md")).version;
    const results = await Promise.allSettled(
      [1, 2, 3, 4, 5].map((n) => m.memory.write(writer, "shared/log.md", `# Log\n\nwriter ${n}\n`, "rewrite", base)),
    );
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    expect(results.filter((r) => r.status === "rejected" && (r.reason as any).code === "stale").length).toBe(4);
  });

  test("concurrent writes to different files all land and are indexed", async () => {
    const paths = Array.from({ length: 20 }, (_, i) => `shared/n${i}.md`);
    const body = Array.from({ length: 10 }, (_, j) => `## Part ${j}\n\nobelisk ${j}`).join("\n\n");
    await Promise.all(paths.map((p, i) => m.memory.write({ name: `agent${i}`, grants: writer.grants }, p, `# N\n\n${body}\n`, "create")));
    const hits = new Set((await m.memory.search(writer, "obelisk", undefined, 50)).results.map((r) => r.path));
    expect([...hits].sort()).toEqual([...paths].sort());
  });

  test("edit replaces text that matches exactly once", async () => {
    await m.memory.write(writer, "shared/e.md", "# E\n\nred red blue\n", "create");
    await expect(m.memory.edit(writer, "shared/e.md", "red", "x", "t")).rejects.toMatchObject({ code: "ambiguous" });
    await expect(m.memory.edit(writer, "shared/e.md", "green", "x", "t")).rejects.toMatchObject({ code: "no_match" });
    await m.memory.edit(writer, "shared/e.md", "blue", "green $& $1", "recolour");
    expect((await m.memory.read(writer, "shared/e.md")).content).toBe("# E\n\nred red green $& $1\n");
    await expect(m.memory.edit(writer, "shared/e.md", "red", "x", "")).rejects.toMatchObject({ code: "bad_why" });
  });

  test("every write is a commit by the agent with why; old versions stay readable", async () => {
    const v1 = await m.memory.write(writer, "projects/shop/notes.md", "# Shop\n\nUses Stripe.\n", "first note");
    await m.memory.edit({ name: "bob", grants: null }, "projects/shop/notes.md", "Stripe", "Paddle", "switched provider");
    const { versions } = await m.memory.history(writer, "projects/shop/notes.md");
    expect(versions.map((v) => [v.agent, v.why])).toEqual([
      ["bob", "switched provider"],
      ["ada", "first note"],
    ]);
    expect(versions[1].version).toBe(v1.version);
    const old = await m.memory.read(writer, "projects/shop/notes.md", { version: v1.version! });
    expect(old.content).toContain("Stripe");
    const byCommit = await m.memory.read(writer, "projects/shop/notes.md", { version: versions[1].commit });
    expect(byCommit.content).toContain("Stripe");
    const { diff } = await m.memory.diff(writer, "projects/shop/notes.md", versions[1].commit, versions[0].commit);
    expect(diff).toContain("-Uses Stripe.");
    expect(diff).toContain("+Uses Paddle.");

    await m.memory.delete(writer, "projects/shop/notes.md", "no longer needed");
    await expect(m.memory.read(writer, "projects/shop/notes.md")).rejects.toMatchObject({ code: "not_found" });
    const after = await m.memory.history(writer, "projects/shop/notes.md");
    expect(after.versions[0]).toMatchObject({ version: null, why: "no longer needed" });

    const restored = await m.memory.restore(ADMIN, "projects/shop/notes.md", versions[0].commit);
    expect((await m.memory.read(writer, "projects/shop/notes.md")).content).toContain("Paddle");
    expect(restored.commit).toBeTruthy();
  });

  test("a version from another file's history is refused", async () => {
    const secret = await m.memory.write(writer, "agents/x/secret.md", "# Secret\n", "create");
    await m.memory.write(writer, "shared/a.md", "# A\n", "create");
    await expect(m.memory.read(writer, "shared/a.md", { version: secret.version! })).rejects.toMatchObject({ code: "not_found" });
  });

  test("lines reads a range", async () => {
    await m.memory.write(writer, "shared/l.md", "one\ntwo\nthree\nfour\n", "create");
    const r = await m.memory.read(writer, "shared/l.md", { lines: "2-3" });
    expect(r.content).toBe("two\nthree");
    expect(r.lines).toEqual({ start: 2, end: 3, total: 4 });
    expect((await m.memory.read(writer, "shared/l.md", { lines: "3-" })).content).toBe("three\nfour");
  });

  test("start returns profiles from the root down, and the map", async () => {
    await m.memory.write(writer, "profile.md", "# Me\n\nRoot facts.\n", "p");
    await m.memory.write(writer, "projects/profile.md", "# Projects\n\nAll projects.\n", "p");
    await m.memory.write(writer, "projects/shop/profile.md", "# Shop\n\nThe shop.\n", "p");
    await m.memory.write(writer, "projects/shop/plan.md", "# Plan\n\nShip it.\n", "p");
    const s = await m.memory.start(writer, "projects/shop");
    expect(s.profiles.map((p) => p.path)).toEqual(["profile.md", "projects/profile.md", "projects/shop/profile.md"]);
    expect(s.map.entries.map((e) => [e.name, e.summary])).toEqual([
      ["plan.md", "Ship it."],
      ["profile.md", "The shop."],
    ]);
    const root = await m.memory.list(writer, "");
    expect(root.entries[0]).toMatchObject({ name: "projects", type: "dir", summary: "All projects." });
  });

  test("changes made outside are picked up on start and by the watcher", async () => {
    await m.memory.write(writer, "shared/a.md", "# A\n\nalpha\n", "create");
    await m.close();
    writeFileSync(join(env.dataDir, "shared/a.md"), "# A\n\nbravo outside\n");
    writeFileSync(join(env.dataDir, "shared/b.md"), "# B\n\ncharlie\n");
    m = await openMemory(env, undefined, { watch: true });
    expect((await m.memory.search(writer, "bravo")).results[0]?.path).toBe("shared/a.md");
    expect((await m.memory.search(writer, "charlie")).results[0]?.path).toBe("shared/b.md");
    expect((await m.memory.history(writer, "shared/b.md")).versions[0].agent).toBe("outside");

    writeFileSync(join(env.dataDir, "shared/c.md"), "# C\n\ndelta watched\n");
    await until(async () => (await m.memory.search(writer, "delta")).results[0]?.path === "shared/c.md");
    await until(async () => (await m.memory.history(writer, "shared/c.md")).versions.length === 1);
  });
});
