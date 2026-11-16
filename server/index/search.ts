// Hybrid search: the word index and the meaning index, merged with
// reciprocal rank fusion (RRF).
import type { Scope, Store } from "../db";
import type { Embeddings } from "./embed";
import { queryTerms } from "./words";

export interface SearchResult {
  path: string;
  heading: string;
  startLine: number;
  endLine: number;
  snippet: string;
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
  const terms = queryTerms(query);
  const inScope = (path: string) => scope === null || scope.some((p) => path.startsWith(p));
  const [wordIds, meaningHits] = await Promise.all([
    store.wordSearch(terms, scope, CANDIDATES),
    // Words never depend on vectors: any failure on the meaning side only drops its list.
    embeddings.search(query, inScope, CANDIDATES).catch(() => null),
  ]);

  const merged = new Map<number, { score: number; wordRank: number | null; meaningRank: number | null }>();
  const entry = (id: number) => {
    let e = merged.get(id);
    if (!e) merged.set(id, (e = { score: 0, wordRank: null, meaningRank: null }));
    return e;
  };
  wordIds.forEach((id, i) => {
    const e = entry(id);
    e.wordRank = i + 1;
    e.score += 1 / (RRF_K + i + 1);
  });
  meaningHits?.forEach((hit, i) => {
    const e = entry(hit.id);
    e.meaningRank = i + 1;
    e.score += 1 / (RRF_K + i + 1);
  });

  const top = [...merged.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, limit);
  const rows = new Map((await store.sectionsById(top.map(([id]) => id))).map((r) => [r.id, r]));
  const results: SearchResult[] = [];
  for (const [id, e] of top) {
    const r = rows.get(id);
    if (!r || !inScope(r.docPath)) continue; // deleted since the vector scan
    results.push({
      path: r.docPath,
      heading: r.heading,
      startLine: r.startLine,
      endLine: r.endLine,
      snippet: snippet(r.text, terms),
      score: Number(e.score.toFixed(6)),
      wordRank: e.wordRank,
      meaningRank: e.meaningRank,
    });
  }
  return { meaning: meaningHits ? "ok" : "unavailable", results };
}

/** About 240 characters of the section, around the first query word if there is one. */
export function snippet(text: string, terms: string[], size = 240): string {
  const body = text.replace(/^#{1,6}\s+.*\n?/, "").replace(/\s+/g, " ").trim() || text.trim();
  if (body.length <= size) return body;
  const lower = body.toLowerCase();
  const hits = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0);
  const at = hits.length ? Math.min(...hits) : 0;
  const start = Math.max(0, Math.min(at - 60, body.length - size));
  return (start > 0 ? "..." : "") + body.slice(start, start + size).trim() + (start + size < body.length ? "..." : "");
}
