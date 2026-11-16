// What makes agents fast with slipbox: the model never stalls the server,
// dates that mean something, snippets that can be pasted into edit, and few
// git processes per write.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Caller } from "../access";
import { type Embedder, WorkerEmbedder } from "../index/embed";
import { snippet } from "../index/search";
import { type Env, backend, makeEnv, openMemory } from "./helpers";

const ada: Caller = { name: "ada", grants: null };
const SLOW_WORKER = new URL("./fixtures/slow-embed-worker.ts", import.meta.url).href;
const SLOW_MS = 300; // what a batch takes in that worker

/** The longest gap between ticks of a 5 ms timer while `during` runs: how long the thread was held. */
async function stall(during: () => Promise<unknown>): Promise<number> {
  let last = performance.now();
  let worst = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 5);
  try {
    await during();
  } finally {
    clearInterval(timer);
  }
  return Math.max(worst, performance.now() - last);
}

describe(`agents stay fast (${backend})`, () => {
  let env: Env;
  let m: Awaited<ReturnType<typeof openMemory>> | null = null;

  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => {
    await m?.close();
    m = null;
    await env.cleanup();
  });

  test("reads stay fast while the model embeds a batch on its own thread", async () => {
    m = await openMemory(env, new WorkerEmbedder("test/slow", env.dir, SLOW_WORKER));
    await m.memory.write(ada, "shared/small.md", "# Small\n\nA small note to read.\n", "create");
    await m.memory.embeddings.settle();
    // A backlog, as after an import or a model change: 40 sections, three batches.
    for (let i = 0; i < 40; i++) await m.memory.write(ada, `shared/n${i}.md`, `# Note ${i}\n\nText number ${i}.\n`, "create");
    expect(m.memory.embeddings.status().queued).toBeGreaterThan(16);
    const reads: number[] = [];
    const worst = await stall(async () => {
      const end = performance.now() + 2 * SLOW_MS;
      while (performance.now() < end) {
        const t = performance.now();
        await m!.memory.read(ada, "shared/small.md");
        reads.push(performance.now() - t);
        await Bun.sleep(5);
      }
    });
    // The worker was busy the whole time, so a batch was in flight during the reads.
    expect(m.memory.embeddings.status().queued).toBeGreaterThan(0);
    expect(worst).toBeLessThan(SLOW_MS / 3);
    expect(Math.max(...reads)).toBeLessThan(SLOW_MS / 3);
    await m.memory.embeddings.settle();
    expect(m.memory.embeddings.status()).toMatchObject({ queued: 0, lastError: null });
  }, 30_000);

  test("on the server's own thread the same model would stall every request", async () => {
    // The measurement above means something: a model on the calling thread holds it for the whole batch.
    const busy: Embedder = {
      model: "test/busy",
      async load() {},
      async embed(texts) {
        const end = performance.now() + SLOW_MS;
        while (performance.now() < end);
        return texts.map(() => new Float32Array(8).fill(0.35));
      },
    };
    expect(await stall(() => busy.embed(["x"], "passage"))).toBeGreaterThan(SLOW_MS * 0.8);
  });

  test("a worker that dies is started again, and its call fails instead of hanging", async () => {
    const e = new WorkerEmbedder("test/slow", env.dir, SLOW_WORKER);
    try {
      await expect(e.embed(["crash"], "passage")).rejects.toThrow("the embedding worker");
      expect((await e.embed(["fine"], "passage")).length).toBe(1);
    } finally {
      e.close();
    }
  }, 20_000);

  test("dates are when a note last changed, from git, after a reindex too", async () => {
    // Notes committed long ago, and one changed since its commit.
    mkdirSync(join(env.dataDir, "shared"), { recursive: true });
    writeFileSync(join(env.dataDir, "shared/old.md"), "# Old\n\nThe limit is 60 a minute per IP.\n");
    writeFileSync(join(env.dataDir, "shared/new.md"), "# New\n\nThe limit is 100 a minute per token.\n");
    const git = (...args: string[]) =>
      Bun.spawnSync(["git", ...args], {
        cwd: env.dataDir,
        env: { ...process.env, GIT_AUTHOR_DATE: "2025-02-10T09:00:00Z", GIT_COMMITTER_DATE: "2025-02-10T09:00:00Z" },
      });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("-c", "user.name=codex", "-c", "user.email=c@x", "commit", "-q", "-m", "seed");
    writeFileSync(join(env.dataDir, "shared/new.md"), "# New\n\nThe limit is 100 a minute per token, since today.\n");

    const today = new Date().toISOString().slice(0, 10);
    const check = async () => {
      const { entries } = await m!.memory.list(ada, "shared");
      expect(entries.find((e) => e.name === "old.md")?.updatedAt).toBe("2025-02-10T09:00:00.000Z");
      expect(entries.find((e) => e.name === "new.md")?.updatedAt?.slice(0, 10)).toBe(today);
      const { results } = await m!.memory.search(ada, "limit minute");
      expect(Object.fromEntries(results.map((r) => [r.path, r.updatedAt?.slice(0, 10)]))).toEqual({
        "shared/old.md": "2025-02-10",
        "shared/new.md": today,
      });
    };
    m = await openMemory(env);
    await check();
    // A reindex drops the index and builds it again from the files: the dates stay.
    await m.store.resetIndex();
    await m.close();
    m = await openMemory(env);
    await check();
  });

  test("a write runs two git processes: add and commit", async () => {
    m = await openMemory(env);
    await m.memory.write(ada, "shared/a.md", "# A\n\none\n", "create");
    const spawn = spyOn(Bun, "spawn");
    try {
      const r = await m.memory.write(ada, "shared/a.md", "# A\n\ntwo\n", "update", (await m.memory.read(ada, "shared/a.md")).version);
      expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
      const git = spawn.mock.calls.map((c) => (c[0] as string[]).find((a) => !a.startsWith("-") && a !== "git" && !a.includes("=")));
      expect(git).toEqual(["add", "commit"]);
      // Nothing to commit is still told apart from a failure.
      const same = await m.memory.edit(ada, "shared/a.md", "two", "two", "no change");
      expect(same.commit).toBeNull();
    } finally {
      spawn.mockRestore();
    }
    expect((await m.memory.history(ada, "shared/a.md")).versions.map((v) => v.why)).toEqual(["update", "create"]);
  });

  test("start skips a profile.md that is not text, instead of failing", async () => {
    m = await openMemory(env);
    await m.memory.write(ada, "shared/profile.md", "# Shared\n\nWhat every agent knows.\n", "create");
    mkdirSync(join(env.dataDir, "projects/shop"), { recursive: true });
    writeFileSync(join(env.dataDir, "projects/shop/profile.md"), new Uint8Array([0x23, 0x20, 0xe9, 0xff, 0x0a]));
    const { profiles } = await m.memory.start(ada, "projects/shop");
    expect(profiles.map((p) => p.path)).toEqual(["shared/profile.md"]);
  });
});

describe("snippets keep the note's lines", () => {
  const section = [
    "## Limits",
    "",
    "Limits are per token, not per IP.",
    "- Bulk endpoints count once.",
    "- Webhooks are not limited.",
    "",
    "",
    "",
    "| plan | per minute |",
    "|---|---|",
    "| free | 100 |",
  ].join("\n");

  test("a snippet's lines appear in the note as they are, so they can be pasted into edit", () => {
    const s = snippet(section, ["bulk"]);
    expect(s).toBe(section.split("\n").slice(2).join("\n").replace(/\n{3,}/, "\n\n"));
    for (const line of s.split("\n")) expect(section).toContain(line);
    expect(section).toContain("Limits are per token, not per IP.\n- Bulk endpoints count once.");
    expect(s).toContain("Limits are per token, not per IP.\n- Bulk endpoints count once.");
  });

  test("a cut between lines is marked on a line of its own", () => {
    const long = ["## Steps", "", ...Array.from({ length: 30 }, (_, i) => `- step ${i}: check the dashboard`)].join("\n");
    const s = snippet(long, ["step 20"]).split("\n");
    expect(s[0]).toBe("...");
    expect(s.at(-1)).toBe("...");
    for (const line of s.slice(1, -1)) expect(long.split("\n")).toContain(line);
    expect(s).toContain("- step 20: check the dashboard");
  });
});
