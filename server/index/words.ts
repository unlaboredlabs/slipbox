// Turns a free-text query into a safe word-index query for each backend.
// Terms are OR-ed: BM25 ranks sections that match more (and rarer) terms higher.

const MAX_TERMS = 32;

// Common English words that carry no meaning for search. Postgres drops these
// itself; SQLite's FTS5 does not, so they are removed from every query.
const STOP_WORDS = new Set(
  ("a about above after again against all am an and any are as at be because been before being below between both " +
    "but by can could did do does doing down during each few for from further had has have having he her here hers " +
    "him his how i if in into is it its itself just me more most my no nor not now of off on once only or other our " +
    "ours out over own same she should so some such than that the their theirs them then there these they this those " +
    "through to too under until up very was we were what when where which while who whom why will with would you " +
    "your yours").split(" "),
);

/** Lowercase word terms from a query, without punctuation, operators or stop words. */
export function queryTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const terms = words.filter((w) => !STOP_WORDS.has(w));
  // A query made only of stop words still searches for them.
  return [...new Set(terms.length ? terms : words)].slice(0, MAX_TERMS);
}

/** SQLite FTS5 MATCH expression: each term quoted, so nothing in the query is read as syntax. */
export function fts5Query(terms: string[]): string {
  return terms.map((t) => `"${t}"`).join(" OR ");
}

/** Postgres to_tsquery expression. Terms are letters and digits only, so they are safe to join. */
export function tsQuery(terms: string[]): string {
  return terms.join(" | ");
}
