// The six reliability rules of search (DESIGN.md), with a stand-in model.
// search-model.test.ts covers real meaning search with the actual model.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { rmSync } from "node:fs";
import type { Caller } from "../access";
import { parseMarkdown } from "../index/sections";
import { type Env, WordsEmbedder, backend, makeEnv, openMemory, until } from "./helpers";

const ada: Caller = { name: "ada", grants: null };

describe(`search reliability (${backend})`, () => {
  let env: Env;
  let opened: Awaited<ReturnType<typeof openMemory>>[] = [];
  const open = async (...args: Parameters<typeof openMemory> extends [any, ...infer R] ? R : never) => {
    const m = await openMemory(env, ...args);
    opened.push(m);
    return m;
  };

  beforeEach(async () => {
    env = await makeEnv();
    opened = [];
  });
  afterEach(async () => {
    for (const m of opened) await m.close();
    await env.cleanup();
  });

  test("1. words never depend on vectors: no model, a model that fails to load, a query that fails to embed", async () => {
    const off = await open(null);
    await off.memory.write(ada, "shared/a.md", "# Billing\n\nInvoices go out monthly.\n", "create");
    let r = await off.memory.search(ada, "invoices");
    expect(r.meaning).toBe("unavailable");
    expect(r.results[0]).toMatchObject({ path: "shared/a.md", wordRank: 1, meaningRank: null });
    await off.close();
    opened = [];

    const broken = new WordsEmbedder();
    broken.failLoad = true;
    const m = await open(broken);
    await m.memory.embeddings.settle();
    r = await m.memory.search(ada, "invoices");
    expect(r.meaning).toBe("unavailable");
    expect(r.results[0]?.path).toBe("shared/a.md");
    expect(m.memory.embeddings.status()).toMatchObject({ loaded: false, lastError: "model files missing" });
    await m.close();
    opened = [];

    const flaky = new WordsEmbedder();
    const m2 = await open(flaky);
    await m2.memory.embeddings.settle();
    flaky.fail = ["query"];
    r = await m2.memory.search(ada, "invoices");
    expect(r.meaning).toBe("unavailable");
    expect(r.results[0]?.path).toBe("shared/a.md");
    expect(m2.memory.embeddings.status().lastError).toContain("query embedding failed");
  });

  test("2. vector search is exact: the same top results as a full cosine scan", async () => {
    const embedder = new WordsEmbedder();
    const { memory } = await open(embedder);
    const words = "apple river stone cloud ember maple quartz violet harbor lantern copper meadow".split(" ");
    for (let i = 0; i < 60; i++) {
      const body = Array.from({ length: 6 }, (_, j) => words[(i * 7 + j * 5) % words.length]).join(" ");
      await memory.write(ada, `shared/n${i}.md`, `# Note ${i}\n\n${body}\n`, "create");
    }
    await memory.embeddings.settle();
    const query = "river ember quartz";
    const [q] = await embedder.embed([query], "query");
    const sections = await opened[0].store.sectionsById((await opened[0].store.sectionRefs()).map((s) => s.id));
    const vectors = await embedder.embed(sections.map((s) => s.text), "query");
    const expected = sections
      .map((s, i) => ({ id: s.id, score: vectors[i].reduce((sum, x, k) => sum + x * q[k], 0) }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);
    const got = (await memory.embeddings.search(query, () => true, 20))!;
    expect(got.map((h) => h.score.toFixed(5))).toEqual(expected.map((h) => h.score.toFixed(5)));
    expect(new Set(got.map((h) => h.id))).toEqual(new Set(expected.map((h) => h.id)));
  });

  test("3. never stale: an edited section's old vector is never used, and deleted ones are dropped", async () => {
    const embedder = new WordsEmbedder();
    const { memory, store } = await open(embedder);
    const text = "# Facts\n\nThe capital is alpha.\n\n## Other\n\nUnrelated words here.\n";
    await memory.write(ada, "shared/f.md", text, "create");
    await memory.embeddings.settle();
    const oldHash = parseMarkdown(text).sections[0].textHash;
    expect((await store.embeddings(embedder.model)).has(oldHash)).toBe(true);

    // The model stops working for passages, so the edited section cannot be re-embedded yet.
    embedder.fail = ["passage"];
    await memory.edit(ada, "shared/f.md", "alpha", "zulu", "correct the fact");
    await memory.embeddings.settle();
    const r = await memory.search(ada, "capital alpha");
    expect(r.meaning).toBe("ok");
    // Found by words (zulu's section still has "capital"), but not through the old vector.
    const hit = r.results.find((x) => x.heading === "Facts")!;
    expect(hit.wordRank).not.toBeNull();
    expect(hit.meaningRank).toBeNull();
    expect((await store.embeddings(embedder.model)).has(oldHash)).toBe(false);
    expect(memory.embeddings.status()).toMatchObject({ total: 2, embedded: 1, queued: 1 });

    // Deleting the file drops its sections' embeddings.
    embedder.fail = [];
    await memory.delete(ada, "shared/f.md", "remove");
    expect((await store.embeddings(embedder.model)).size).toBe(0);
    expect(memory.embeddings.status()).toMatchObject({ total: 0, embedded: 0, queued: 0 });
  });

  test("3. changing the model re-embeds everything", async () => {
    const first = await open(new WordsEmbedder("test/one"));
    await first.memory.write(ada, "shared/a.md", "# A\n\none\n\n## B\n\ntwo\n", "create");
    await first.memory.embeddings.settle();
    await first.close();
    opened = [];

    const other = new WordsEmbedder("test/two");
    const second = await open(other);
    await second.memory.embeddings.settle();
    expect(other.embedded.length).toBe(2);
    expect(second.memory.embeddings.status()).toMatchObject({ model: "test/two", embedded: 2, total: 2 });
    expect((await second.store.embeddings("test/one")).size).toBe(0);
  });

  test("3. only changed sections are re-embedded", async () => {
    const embedder = new WordsEmbedder();
    const { memory } = await open(embedder);
    await memory.write(ada, "shared/a.md", "# A\n\nfirst part\n\n## B\n\nsecond part\n", "create");
    await memory.embeddings.settle();
    embedder.embedded = [];
    await memory.edit(ada, "shared/a.md", "second part", "second part, revised", "revise");
    await memory.embeddings.settle();
    expect(embedder.embedded).toEqual(["## B\n\nsecond part, revised"]);
  });

  test("4. writes never wait on the model, and the queue survives a restart", async () => {
    const stuck = new WordsEmbedder();
    stuck.hang = true; // the model never finishes loading
    const first = await open(stuck);
    const started = performance.now();
    await first.memory.write(ada, "shared/a.md", "# A\n\nlantern harbor\n", "create");
    await first.memory.write(ada, "shared/b.md", "# B\n\ncopper meadow\n", "create");
    expect(performance.now() - started).toBeLessThan(2000);
    const r = await first.memory.search(ada, "lantern");
    expect(r.meaning).toBe("unavailable");
    expect(r.results[0]?.path).toBe("shared/a.md");
    expect(first.memory.embeddings.status()).toMatchObject({ loaded: false, embedded: 0, total: 2, queued: 2 });
    await first.close();
    opened = [];

    // Nothing about the queue was stored: it is derived again on start.
    const working = new WordsEmbedder();
    const second = await open(working);
    await until(() => second.memory.embeddings.status().queued === 0);
    expect(second.memory.embeddings.status()).toMatchObject({ loaded: true, embedded: 2, total: 2 });
    expect((await second.memory.search(ada, "lantern harbor")).results[0]).toMatchObject({ path: "shared/a.md", meaningRank: 1 });
  });

  test("5. health is visible: model, counts, queue and last error", async () => {
    const embedder = new WordsEmbedder();
    embedder.fail = ["passage"];
    const { memory } = await open(embedder);
    await memory.write(ada, "shared/a.md", "# A\n\none\n", "create");
    await memory.embeddings.settle();
    expect(memory.embeddings.status()).toEqual({
      model: "test/words",
      loaded: true,
      embedded: 0,
      total: 1,
      queued: 1,
      lastError: expect.stringContaining("embedding shared/a.md#1 failed"),
    });
  });

  test("6. rebuildable: delete the database and everything comes back from the files", async () => {
    const first = await open(new WordsEmbedder());
    await first.memory.write(ada, "shared/a.md", "# Alpha\n\nquartz violet\n", "create");
    await first.memory.write(ada, "projects/x/b.md", "# Beta\n\nember maple\n", "create");
    await first.close();
    opened = [];
    if (backend === "sqlite") rmSync(env.dbUrl);
    else {
      const sql = new SQL(env.dbUrl);
      await sql.unsafe("drop schema public cascade");
      await sql.unsafe("create schema public");
      await sql.close();
    }

    const second = await open(new WordsEmbedder());
    await until(() => second.memory.embeddings.status().queued === 0);
    expect(second.memory.embeddings.status()).toMatchObject({ embedded: 2, total: 2 });
    expect((await second.memory.search(ada, "ember")).results[0]?.path).toBe("projects/x/b.md");
    expect((await second.memory.list(ada, "shared")).entries[0]).toMatchObject({ name: "a.md", summary: "quartz violet" });
  });

  test("search is limited to what the key may read, and to a path", async () => {
    const { memory } = await open(new WordsEmbedder());
    await memory.write(ada, "shared/a.md", "# A\n\nharbor notes\n", "create");
    await memory.write(ada, "projects/shop/b.md", "# B\n\nharbor plans\n", "create");
    await memory.write(ada, "projects/blog/c.md", "# C\n\nharbor posts\n", "create");
    await memory.embeddings.settle();
    const shop: Caller = { name: "shop", grants: [{ prefix: "projects/shop/", mode: "write" }, { prefix: "shared/", mode: "read" }] };
    const paths = (await memory.search(shop, "harbor")).results.map((r) => r.path).sort();
    expect(paths).toEqual(["projects/shop/b.md", "shared/a.md"]);
    const scoped = (await memory.search(shop, "harbor", "projects")).results.map((r) => r.path);
    expect(scoped).toEqual(["projects/shop/b.md"]);
    expect((await memory.search(ada, "harbor", "projects/blog")).results.map((r) => r.path)).toEqual(["projects/blog/c.md"]);
  });
});
