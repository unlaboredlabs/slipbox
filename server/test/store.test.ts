// The database layer on its own.
import { expect, test } from "bun:test";
import { openStore } from "../db";
import { backend, makeEnv } from "./helpers";

test(`re-indexing is atomic to the rest of the process (${backend})`, async () => {
  const env = await makeEnv();
  const store = await openStore(env.dbUrl);
  try {
    const doc = { path: "shared/a.md", title: "A", summary: "", hash: "h", bytes: 1, updatedAt: new Date().toISOString() };
    const sections = Array.from({ length: 50 }, (_, i) => ({
      heading: `Part ${i}`,
      startLine: i + 1,
      endLine: i + 1,
      text: `zeppelin ${i}`,
      textHash: `hash-${i}`,
    }));
    await store.putDoc(doc, sections);
    // Re-indexes and searches all at once: no search sees the doc half replaced,
    // and no two transactions collide.
    let empty = 0;
    await Promise.all([
      ...Array.from({ length: 20 }, () => store.putDoc(doc, sections)),
      ...Array.from({ length: 200 }, async () => {
        if ((await store.wordSearch(["zeppelin"], null, 5)).length === 0) empty++;
      }),
    ]);
    expect(empty).toBe(0);
    expect((await store.counts()).sections).toBe(50);
  } finally {
    await store.close();
    await env.cleanup();
  }
});
