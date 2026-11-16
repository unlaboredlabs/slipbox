// Meaning search with the real local model (downloaded once into MODELS_DIR).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Caller } from "../access";
import { DEFAULT_MODEL, LocalEmbedder } from "../index/embed";
import { AGENT_NOTES, AGENT_QUERIES } from "./fixtures/agent-notes";
import { NOTES, QUERIES } from "./fixtures/relevance";
import { type Env, MODELS_DIR, backend, makeEnv, openMemory } from "./helpers";

const ada: Caller = { name: "ada", grants: null };

describe(`search with the real model (${backend})`, () => {
  let env: Env;
  let m: Awaited<ReturnType<typeof openMemory>>;

  beforeAll(async () => {
    env = await makeEnv();
    m = await openMemory(env, new LocalEmbedder(DEFAULT_MODEL, MODELS_DIR));
    const notes: Record<string, string> = {
      "shared/pets.md": "# Office pets\n\nOur office dog is a golden retriever named Biscuit who loves playing fetch in the yard.\n",
      "shared/billing.md": "# Billing\n\nInvoices are sent through Stripe on the first business day of each month.\n",
      "shared/deploys.md": "# Deploys\n\nProduction releases go out on Tuesdays, after the staging smoke tests pass.\n",
      "shared/food.md": "# Lunch\n\nThe team orders pizza from the place on Fifth Street every Friday.\n",
    };
    for (const [path, text] of Object.entries(notes)) await m.memory.write(ada, path, text, "create");
    await m.memory.embeddings.settle();
  }, 300_000);

  afterAll(async () => {
    await m.close();
    await env.cleanup();
  });

  test("the model loads and embeds every section", () => {
    expect(m.memory.embeddings.status()).toMatchObject({ loaded: true, embedded: 4, total: 4, queued: 0, lastError: null });
  });

  test("meaning only: a paraphrase with no shared words", async () => {
    const r = await m.memory.search(ada, "which canine lives at the workplace?");
    expect(r.meaning).toBe("ok");
    expect(r.results[0]).toMatchObject({ path: "shared/pets.md", wordRank: null, meaningRank: 1 });

    const r2 = await m.memory.search(ada, "when are customers charged");
    expect(r2.results[0]).toMatchObject({ path: "shared/billing.md", wordRank: null, meaningRank: 1 });
  });

  test("merged: a section matched by words and meaning ranks first", async () => {
    const r = await m.memory.search(ada, "stripe invoices schedule");
    expect(r.results[0]).toMatchObject({ path: "shared/billing.md", wordRank: 1, meaningRank: 1 });
    // Every result says which of words and meaning matched it.
    for (const x of r.results) expect(x.wordRank !== null || x.meaningRank !== null).toBe(true);
  });

  test("words only: an exact rare term still wins through the word index", async () => {
    const r = await m.memory.search(ada, "Biscuit");
    expect(r.results[0]).toMatchObject({ path: "shared/pets.md", wordRank: 1 });
  });
});

describe(`meaning relevance with the real model (${backend})`, () => {
  let env: Env;
  let m: Awaited<ReturnType<typeof openMemory>>;

  beforeAll(async () => {
    env = await makeEnv();
    m = await openMemory(env, new LocalEmbedder(DEFAULT_MODEL, MODELS_DIR));
    for (const [path, text] of Object.entries(NOTES)) await m.memory.write(ada, path, text, "create");
    await m.memory.embeddings.settle();
  }, 300_000);

  afterAll(async () => {
    await m.close();
    await env.cleanup();
  });

  const meaningPaths = async (query: string) =>
    (await m.memory.search(ada, query)).results.filter((r) => r.meaningRank !== null).map((r) => r.path);

  test("unrelated notes are not returned as meaning matches", async () => {
    const r = await m.memory.search(ada, "what happens when a card is declined");
    const paths = r.results.map((x) => x.path);
    for (const unrelated of ["shared/deploys.md", "shared/team.md", "agents/planner/notes.md", "shared/office.md"]) {
      expect(paths).not.toContain(unrelated);
    }
    // The note that answers it comes first, ahead of "Gift cards", which only shares the word "card".
    expect(r.results[0]).toMatchObject({ path: "projects/shop/payment-retries.md", meaningRank: 1 });
  });

  test("a paraphrase still finds its note", async () => {
    expect(await meaningPaths("which canine lives at the workplace")).toEqual(["shared/office.md"]);
  });

  test("a query nothing answers returns nothing, rather than everything", async () => {
    expect((await m.memory.search(ada, "how to tune a guitar")).results).toEqual([]);
    expect(await meaningPaths("the history of the roman empire")).toEqual([]);
  });

  test("on the labelled set, every answering note is a meaning match, and few others are", async () => {
    let noise = 0;
    let unanswered = 0;
    for (const [query, answers] of QUERIES) {
      const found = await meaningPaths(query);
      for (const a of answers) expect({ query, found: found.includes(a) }).toEqual({ query, found: true });
      noise += found.filter((p) => !answers.includes(p)).length;
      if (!answers.length) {
        expect({ query, matches: found.length <= 3 }).toEqual({ query, matches: true }); // of 10 notes
        if (!found.length) unanswered++;
      }
    }
    // Measured: 16 of the 274 non-answering query-note pairs pass (all did without the floor),
    // and none of the 8 queries nothing answers gets a meaning match.
    expect(noise).toBeLessThanOrEqual(20);
    expect(unanswered).toBeGreaterThanOrEqual(7);
  });
});

describe(`relevance on notes the way agents write them, with the real model (${backend})`, () => {
  let env: Env;
  let m: Awaited<ReturnType<typeof openMemory>>;

  beforeAll(async () => {
    env = await makeEnv();
    m = await openMemory(env, new LocalEmbedder(DEFAULT_MODEL, MODELS_DIR));
    for (const [path, text] of Object.entries(AGENT_NOTES)) await m.memory.write(ada, path, text, "create");
    await m.memory.embeddings.settle();
  }, 300_000);

  afterAll(async () => {
    await m.close();
    await env.cleanup();
  });

  test("every answering note is in the top 10, by words or meaning", async () => {
    const missed: string[] = [];
    for (const [query, answers] of AGENT_QUERIES) {
      const paths = (await m.memory.search(ada, query)).results.map((r) => r.path);
      for (const a of answers) if (!paths.includes(a)) missed.push(`${query} -> ${a}`);
    }
    expect(missed).toEqual([]);
  });

  test("queries nothing answers get few meaning matches, most of them none", async () => {
    const counts: number[] = [];
    for (const [query, answers] of AGENT_QUERIES) {
      if (answers.length || !/^[\p{L} ]+$/u.test(query)) continue; // plain-language ones; SQL-looking text resembles the migration notes
      counts.push((await m.memory.search(ada, query)).results.filter((r) => r.meaningRank !== null).length);
    }
    // Measured: 0, 0, 2, 0, 4, 1 of 125 sections (up to 38 before the floor was raised to 0.56).
    expect(counts.length).toBe(6);
    expect(Math.max(...counts)).toBeLessThanOrEqual(6);
    expect(counts.filter((n) => n === 0).length).toBeGreaterThanOrEqual(3);
  });
});
