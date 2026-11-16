// Turns a free-text query into a safe word-index query for each backend.
// Terms are OR-ed: BM25 ranks sections that match more (and rarer) terms higher.

const MAX_TERMS = 32;

/** Lowercase word terms from a query, without punctuation or operators. */
export function queryTerms(query: string): string[] {
  const terms = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(terms)].slice(0, MAX_TERMS);
}

/** SQLite FTS5 MATCH expression: each term quoted, so nothing in the query is read as syntax. */
export function fts5Query(terms: string[]): string {
  return terms.map((t) => `"${t}"`).join(" OR ");
}

/** Postgres to_tsquery expression. Terms are letters and digits only, so they are safe to join. */
export function tsQuery(terms: string[]): string {
  return terms.join(" | ");
}
