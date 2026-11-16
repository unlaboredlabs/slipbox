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

const WORD = /[\p{L}\p{N}]+/gu;

/**
 * Lowercase word terms from a query, without punctuation, operators or stop
 * words. A query made only of stop words has no terms, on both backends.
 *
 * An identifier, path or version (stg_shop__orders, route.ts, v2.14.0) also
 * becomes a phrase of its parts in a row, written as one term with spaces, so
 * a note that has it outranks notes that only share its common parts.
 */
export function queryTerms(query: string): string[] {
  const lower = query.toLowerCase();
  const terms = (lower.match(WORD) ?? []).filter((w) => !STOP_WORDS.has(w));
  const phrases = lower
    .split(/\s+/)
    .filter((token) => /[\p{L}\p{N}][_./-]+[\p{L}\p{N}]/u.test(token))
    .map((token) => token.match(WORD) ?? [])
    .filter((parts) => parts.length > 1)
    .map((parts) => parts.join(" "));
  return [...new Set([...phrases, ...terms])].slice(0, MAX_TERMS);
}

/** Whether the query has anything to search for: a letter or a digit. */
export function hasWords(query: string): boolean {
  return /[\p{L}\p{N}]/u.test(query);
}

/**
 * Text as the word index sees it on Postgres: letters and digits, everything
 * else a space. Its parser would otherwise keep a path, host, version or email
 * (src/app/route.ts, stripe.webhooks.constructEvent, v2.14.0) as one token,
 * and a query for a word inside it would never match. SQLite's tokenizer
 * splits the same way by itself.
 */
export function wordText(text: string): string {
  return text.replace(/[^\p{L}\p{N}]+/gu, " ");
}

/** SQLite FTS5 MATCH expression: each term quoted (a phrase when it has spaces), so nothing in the query is read as syntax. */
export function fts5Query(terms: string[]): string {
  return terms.map((t) => `"${t}"`).join(" OR ");
}

/** Postgres to_tsquery expression. Terms are letters, digits and spaces only, so they are safe to join. */
export function tsQuery(terms: string[]): string {
  return terms.map((t) => (t.includes(" ") ? `(${t.split(" ").join(" <-> ")})` : t)).join(" | ");
}

/** The phrases among the terms, as a Postgres to_tsquery expression, or null if there are none. */
export function tsPhrases(terms: string[]): string | null {
  const phrases = terms.filter((t) => t.includes(" "));
  return phrases.length ? tsQuery(phrases) : null;
}
