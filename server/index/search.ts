// Hybrid search: the word index and the meaning index, merged with
// reciprocal rank fusion (RRF).
import type { Scope, Store } from "../db";
import { UserError } from "../files";
import type { Embeddings } from "./embed";
import { hasWords, queryTerms, wordText } from "./words";

export interface SearchResult {
  path: string;
  heading: string;
  startLine: number;
  endLine: number;
  snippet: string;
  /** When the note last changed, so a newer note can win over an older one that disagrees. */
  updatedAt: string | null;
  score: number;
  wordRank: number | null; // 1-based rank in the word results, null if words did not match
  meaningRank: number | null;
}

export interface SearchResponse {
  meaning: "ok" | "unavailable";
  results: SearchResult[];
}

/** The usual RRF constant: damps the weight of top ranks so neither list dominates. */
const RRF_K = 60;
/** How many candidates each index contributes before merging. */
const CANDIDATES = 50;

export async function hybridSearch(
  store: Store,
  embeddings: Embeddings,
  query: string,
  scope: Scope,
  limit: number,
): Promise<SearchResponse> {
  if (!hasWords(query)) throw new UserError("bad_query", "query has no words: search for letters or digits.");
  const terms = queryTerms(query);
  const inScope = (path: string) => scope === null || scope.some((p) => path.startsWith(p));
  // Meaning first: it waits on the model, and a note can be re-indexed (with
  // new section ids) meanwhile. The word search runs after, and returns whole
  // rows, so what words find is never lost to such a change.
  // Words never depend on vectors: any failure on the meaning side only drops its list.
  const meaningHits = await embeddings.search(query, inScope, CANDIDATES).catch(() => null);
  const wordRows = await store.wordSearch(terms, scope, CANDIDATES);

  // A section with an identifier, path or version from the query, whole,
  // comes before sections that only share some of its words or its meaning.
  const phrases = terms.filter((t) => t.includes(" ")).map((t) => ` ${t} `);
  const exact = (text: string) => {
    if (!phrases.length) return false;
    const words = ` ${wordText(text).toLowerCase()} `;
    return phrases.some((p) => words.includes(p));
  };

  const merged = new Map<number, { score: number; exact: boolean; wordRank: number | null; meaningRank: number | null }>();
  const entry = (id: number) => {
    let e = merged.get(id);
    if (!e) merged.set(id, (e = { score: 0, exact: false, wordRank: null, meaningRank: null }));
    return e;
  };
  wordRows.forEach((row, i) => {
    const e = entry(row.id);
    e.wordRank = i + 1;
    e.exact = exact(row.text);
    e.score += 1 / (RRF_K + i + 1);
  });
  meaningHits?.forEach((hit, i) => {
    const e = entry(hit.id);
    e.meaningRank = i + 1;
    e.score += 1 / (RRF_K + i + 1);
  });

  const top = [...merged.entries()]
    .sort((a, b) => Number(b[1].exact) - Number(a[1].exact) || b[1].score - a[1].score)
    .slice(0, limit);
  const rows = new Map(wordRows.map((r) => [r.id, r]));
  const missing = top.map(([id]) => id).filter((id) => !rows.has(id));
  for (const r of await store.sectionsById(missing)) rows.set(r.id, r);
  const paths = [...new Set(top.map(([id]) => rows.get(id)?.docPath).filter((p): p is string => !!p))];
  const updated = new Map((await store.docsByPath(paths)).map((d) => [d.path, d.updatedAt]));
  const results: SearchResult[] = [];
  for (const [id, e] of top) {
    const r = rows.get(id);
    if (!r || !inScope(r.docPath)) continue; // a meaning hit deleted since the vector scan
    results.push({
      path: r.docPath,
      heading: r.heading,
      startLine: r.startLine,
      endLine: r.endLine,
      snippet: snippet(r.text, terms),
      updatedAt: updated.get(r.docPath) ?? null,
      score: Number(e.score.toFixed(6)),
      wordRank: e.wordRank,
      meaningRank: e.meaningRank,
    });
  }
  return { meaning: meaningHits ? "ok" : "unavailable", results };
}

/**
 * About 240 characters of the section, around the first query word if there is one. Its lines are
 * kept as they are (only runs of blank lines become one), so a piece of it can be copied into edit's
 * old; "..." marks a cut, on a line of its own when the cut falls between lines.
 */
export function snippet(text: string, terms: string[], size = 240): string {
  const clean = (t: string) => t.replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, "\n\n").replace(/^(?:[ \t]*\n)+/, "").trimEnd();
  const body = clean(text.replace(/^(#{1,6}\s+.*|.*\n {0,3}(=+|-{2,})[ \t]*)(\n|$)/, "")) || clean(text);
  if (body.length <= size) return body;
  const lower = body.toLowerCase();
  const hits = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0);
  const at = hits.length ? Math.min(...hits) : 0;
  let start = Math.max(0, Math.min(at - 60, body.length - size));
  // Whole lines, unless the hit sits far into a long line.
  const lineStart = body.lastIndexOf("\n", start - 1) + 1;
  if (at - lineStart <= size / 2) start = lineStart;
  let end = Math.min(body.length, start + size);
  const lineEnd = body.lastIndexOf("\n", end);
  if (end < body.length && lineEnd > Math.max(start, at)) end = lineEnd;
  const before = start === 0 ? "" : body[start - 1] === "\n" ? "...\n" : "...";
  const after = end >= body.length ? "" : body[end] === "\n" ? "\n..." : "...";
  return before + body.slice(start, end) + after;
}
