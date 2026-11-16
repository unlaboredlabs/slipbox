// The word index finds the same words on SQLite and Postgres: identifiers,
// paths, versions and emails included.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Caller } from "../access";
import { queryTerms } from "../index/words";
import { type Env, WordsEmbedder, backend, makeEnv, openMemory } from "./helpers";

const ada: Caller = { name: "ada", grants: null };

describe(`word search (${backend})`, () => {
  let env: Env;
  let m: Awaited<ReturnType<typeof openMemory>>;

  beforeAll(async () => {
    env = await makeEnv();
    // The stand-in model matches the meeting notes by "meaning" too, as a real one does.
    m = await openMemory(env, new WordsEmbedder());
    const notes: Record<string, string> = {
      "projects/shop/stripe.md":
        "# Stripe webhooks\n\nVerify with stripe.webhooks.constructEvent(body, sig, secret) in src/app/api/webhooks/stripe/route.ts.\n",
      "shared/python.md": "# Python style\n\nRuff is configured in pyproject.toml.\n",
      "shared/release.md": "# Release\n\nThe last tag was v2.14.0, on Kubernetes 1.31.\n",
      "shared/people.md": "# People\n\nWrite to ops@example.com for access.\n",
      "projects/data/naming.md": "# dbt naming\n\nStaging models are named like stg_shop__orders, one per source table.\n",
    };
    // Notes that share only the parts of that identifier, many times, but not the identifier.
    for (let w = 1; w <= 6; w++) {
      notes[`projects/shop/meetings/w${w}.md`] =
        `# Shop orders weekly ${w}\n\nShop orders on stg were reviewed. Orders in the shop went up on stg too; shop orders backlog is down.\n`;
    }
    for (const [path, text] of Object.entries(notes)) await m.memory.write(ada, path, text, "create");
    await m.memory.embeddings.settle();
  });

  afterAll(async () => {
    await m.close();
    await env.cleanup();
  });

  const first = async (query: string) => (await m.memory.search(ada, query)).results[0];

  test("a word inside a dotted identifier, a path, a version or an email is found", async () => {
    for (const q of ["constructEvent", "webhooks constructEvent", "route.ts", "pyproject", "toml"]) {
      expect({ q, hit: await first(q) }).toMatchObject({ q, hit: { wordRank: 1 } });
    }
    expect(await first("constructEvent")).toMatchObject({ path: "projects/shop/stripe.md", wordRank: 1 });
    expect(await first("pyproject")).toMatchObject({ path: "shared/python.md", wordRank: 1 });
    expect(await first("v2.14.0")).toMatchObject({ path: "shared/release.md", wordRank: 1 });
    expect(await first("1.31")).toMatchObject({ path: "shared/release.md", wordRank: 1 });
    expect(await first("ops@example.com")).toMatchObject({ path: "shared/people.md", wordRank: 1 });
  });

  test("an exact snake_case identifier outranks notes that only share its parts, by words and by meaning", async () => {
    const r = await m.memory.search(ada, "stg_shop__orders");
    expect(r.results.some((x) => x.path.includes("meetings") && x.meaningRank !== null && x.wordRank !== null)).toBe(true);
    expect(await first("stg_shop__orders")).toMatchObject({ path: "projects/data/naming.md", wordRank: 1 });
    expect(await first("where is stg_shop__orders defined")).toMatchObject({ path: "projects/data/naming.md", wordRank: 1 });
  });

  test("a query of only stop words has no word hits, on either backend", async () => {
    expect(queryTerms("how do I")).toEqual([]);
    expect((await m.memory.search(ada, "how do I")).results).toEqual([]);
  });

  test("a query of only punctuation is refused", async () => {
    await expect(m.memory.search(ada, "?")).rejects.toThrow("query has no words");
  });
});
