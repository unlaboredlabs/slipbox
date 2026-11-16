// The meaning index: section embeddings from a local in-process model, kept
// in memory, and searched exactly by brute-force cosine similarity.
//
// Reliability rules (see DESIGN.md):
// - Words never depend on this: every failure here is recorded and search
//   falls back to the word index.
// - An embedding is keyed by its section's text hash and the model name, and
//   search looks vectors up by the section's *current* hash, so a stale vector
//   can never be used.
// - Pending work is derived (sections whose hash has no vector), not stored,
//   so the queue survives a restart.
import { join } from "node:path";
import type { Store } from "../db";
import { prepareNativeRuntime } from "../native";

export interface Embedder {
  readonly model: string;
  load(): Promise<void>;
  /** Unit-length vectors, one per text. */
  embed(texts: string[], kind: "query" | "passage"): Promise<Float32Array[]>;
}

/** Runs a Hugging Face model in-process with @huggingface/transformers (onnxruntime). */
export class LocalEmbedder implements Embedder {
  private extractor: any = null;

  constructor(
    readonly model: string,
    private cacheDir: string,
  ) {}

  async load() {
    if (this.extractor) return;
    await prepareNativeRuntime(join(this.cacheDir, "runtime"));
    const { pipeline, env } = await import("@huggingface/transformers");
    env.cacheDir = this.cacheDir;
    this.extractor = await pipeline("feature-extraction", this.model, { dtype: "fp32" });
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!this.extractor) throw new Error("model not loaded");
    // BGE models are trained with CLS pooling, most others with mean pooling.
    const pooling = /bge/i.test(this.model) ? "cls" : "mean";
    const out = await this.extractor(
      texts.map((t) => t.slice(0, 4000)),
      { pooling, normalize: true },
    );
    const [n, dims] = out.dims as [number, number];
    const data = out.data as Float32Array;
    return Array.from({ length: n }, (_, i) => data.slice(i * dims, (i + 1) * dims));
  }
}

export interface EmbedStatus {
  model: string;
  loaded: boolean;
  embedded: number;
  total: number;
  queued: number;
  lastError: string | null;
}

/**
 * A section counts as a meaning match only if its cosine similarity is at
 * least `min`, and within `belowTop` of the best section for that query.
 * Without this every section would come back as a "match", ranked.
 *
 * Measured with the default model (bge-small-en-v1.5) on the labelled set in
 * server/test/fixtures/relevance.ts. Answering notes score 0.57 to 0.80, and a
 * wordy real paraphrase as low as 0.52. Queries far from every note top out
 * below 0.49, but short everyday questions reach 0.55 against the nearest
 * note, so no floor separates everything: this one keeps every answer, and
 * the margin leaves those near misses one to three hits, not the whole index.
 * With another EMBED_MODEL, measure again: models differ in how high their
 * similarities run.
 */
export const MEANING_FLOOR = { min: 0.5, belowTop: 0.1 };

const BATCH = 16;
const RETRY_MS = 30_000;

export class Embeddings {
  /** Section id -> its doc path and current text hash. */
  private sections = new Map<number, { path: string; hash: string }>();
  /** Text hash -> vector, for the current model only. */
  private vectors = new Map<string, Float32Array>();
  /** Hashes whose text the model failed on; retried after a restart. */
  private failed = new Set<string>();
  private loaded = false;
  private running: Promise<void> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private ready = false; // set once init has loaded the stored vectors
  lastError: string | null = null;

  constructor(
    private store: Store,
    private embedder: Embedder | null,
  ) {}

  get model() {
    return this.embedder?.model ?? "off";
  }

  async init() {
    this.sections.clear();
    for (const s of await this.store.sectionRefs()) this.sections.set(s.id, { path: s.docPath, hash: s.textHash });
    if (!this.embedder) return;
    await this.store.pruneEmbeddings(this.model);
    this.vectors = await this.store.embeddings(this.model);
    this.ready = true;
    this.kick();
  }

  /** Records a doc's new sections and queues any that need an embedding. */
  setDoc(path: string, sections: { id: number; textHash: string }[]) {
    this.dropDoc(path, false);
    for (const s of sections) this.sections.set(s.id, { path, hash: s.textHash });
    this.kick();
  }

  dropDoc(path: string, prune = true) {
    for (const [id, s] of this.sections) if (s.path === path) this.sections.delete(id);
    if (prune) this.pruneVectors();
  }

  private pruneVectors() {
    const live = new Set([...this.sections.values()].map((s) => s.hash));
    for (const h of this.vectors.keys()) if (!live.has(h)) this.vectors.delete(h);
  }

  status(): EmbedStatus {
    let embedded = 0;
    for (const s of this.sections.values()) if (this.vectors.has(s.hash)) embedded++;
    const total = this.sections.size;
    return {
      model: this.model,
      loaded: this.loaded,
      embedded,
      total,
      queued: this.embedder ? total - embedded : 0,
      lastError: this.lastError,
    };
  }

  /** Section ids, one per text hash, that still need an embedding. */
  private pending(max: number): number[] {
    const seen = new Set<string>();
    const ids: number[] = [];
    for (const [id, s] of this.sections) {
      if (this.vectors.has(s.hash) || this.failed.has(s.hash) || seen.has(s.hash)) continue;
      seen.add(s.hash);
      ids.push(id);
      if (ids.length >= max) break;
    }
    return ids;
  }

  /** Starts working through the queue in the background, if not already. */
  kick() {
    if (!this.embedder || !this.ready || this.running || this.closed) return;
    this.running = this.work().finally(() => {
      this.running = null;
    });
  }

  /** Resolves when the queue is empty or the model is unavailable. For tests and the reindex command. */
  async settle() {
    while (this.running) await this.running;
  }

  close() {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
  }

  private async work() {
    const embedder = this.embedder!;
    try {
      if (!this.loaded) {
        await embedder.load();
        this.loaded = true;
        this.lastError = null;
      }
      for (let ids = this.pending(BATCH); ids.length && !this.closed; ids = this.pending(BATCH)) {
        const rows = await this.store.sectionsById(ids);
        let vectors: Float32Array[];
        try {
          vectors = await embedder.embed(rows.map((r) => r.text), "passage");
        } catch (err) {
          // Find the text that fails, so one bad section cannot block the rest.
          vectors = [];
          for (const r of rows) {
            try {
              vectors.push((await embedder.embed([r.text], "passage"))[0]);
            } catch (e) {
              this.failed.add(r.textHash);
              this.lastError = `embedding ${r.docPath}#${r.startLine} failed: ${message(e)}`;
              vectors.push(new Float32Array());
            }
          }
        }
        // Sections are re-read from the database, so one edited meanwhile is simply queued again.
        for (let i = 0; i < rows.length; i++) {
          const { textHash } = rows[i];
          if (!vectors[i].length) continue;
          await this.store.putEmbedding(textHash, embedder.model, vectors[i]);
          this.vectors.set(textHash, vectors[i]);
        }
        // A section gone from the database was deleted meanwhile.
        for (const id of ids) if (!rows.some((r) => r.id === id)) this.sections.delete(id);
      }
    } catch (err) {
      this.lastError = message(err);
      if (!this.closed) {
        this.retry = setTimeout(() => {
          this.retry = null;
          this.kick();
        }, RETRY_MS);
      }
    }
  }

  /**
   * Exact nearest sections by cosine similarity (vectors are unit length, so
   * a dot product), above MEANING_FLOOR. Returns null when meaning search is unavailable.
   *
   * This is a linear scan over every permitted section, which stays fast to
   * about 100k sections. Past that, an exact index (or sharding the scan
   * across workers) belongs here; an approximate one would break the
   * "no missed neighbours" guarantee.
   */
  async search(query: string, canRead: (path: string) => boolean, limit: number) {
    if (!this.embedder || !this.loaded) return null;
    let q: Float32Array;
    try {
      [q] = await this.embedder.embed([query], "query");
    } catch (err) {
      this.lastError = `query embedding failed: ${message(err)}`;
      return null;
    }
    const hits: { id: number; score: number }[] = [];
    for (const [id, s] of this.sections) {
      const v = this.vectors.get(s.hash);
      if (!v || v.length !== q.length || !canRead(s.path)) continue;
      let dot = 0;
      for (let i = 0; i < q.length; i++) dot += q[i] * v[i];
      if (dot < MEANING_FLOOR.min) continue;
      hits.push({ id, score: dot });
    }
    hits.sort((a, b) => b.score - a.score);
    const cut = (hits[0]?.score ?? 0) - MEANING_FLOOR.belowTop;
    return hits.filter((h) => h.score >= cut).slice(0, limit);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
