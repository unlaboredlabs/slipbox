// Test helpers. Every test gets its own data folder and database: a SQLite file
// by default, or a fresh Postgres database when TEST_DATABASE_URL is set.
import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Store, openStore } from "../db";
import type { Embedder } from "../index/embed";
import { Memory } from "../memory";
import { NAME } from "../name";

export const backend = process.env.TEST_DATABASE_URL ? "postgres" : "sqlite";

/** Where the real embedding model is cached between test runs. */
export const MODELS_DIR = process.env.TEST_MODELS_DIR || join(tmpdir(), `${NAME}-test-models`);

export interface Env {
  dir: string;
  dataDir: string;
  dbUrl: string;
  cleanup(): Promise<void>;
}

export async function makeEnv(): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), `${NAME}-test-`));
  const admin = process.env.TEST_DATABASE_URL;
  let dbUrl = join(dir, "data.db");
  let dropDb = async () => {};
  if (admin) {
    const name = `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const sql = new SQL(admin);
    await sql.unsafe(`create database ${name}`);
    await sql.close();
    const url = new URL(admin);
    url.pathname = "/" + name;
    dbUrl = url.toString();
    dropDb = async () => {
      const s = new SQL(admin);
      await s.unsafe(`drop database if exists ${name} with (force)`);
      await s.close();
    };
  }
  return {
    dir,
    dataDir: join(dir, "data"),
    dbUrl,
    async cleanup() {
      await dropDb();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function openMemory(env: Env, embedder: Embedder | null = new WordsEmbedder(), opts: { watch?: boolean } = {}) {
  const store = await openStore(env.dbUrl);
  const memory = await Memory.open({ dataDir: env.dataDir, maxFileBytes: 32 * 1024, store, embedder, watch: opts.watch });
  return {
    memory,
    store,
    async close() {
      await memory.close();
      await store.close();
    },
  };
}

/**
 * A fast, deterministic stand-in for a model: a hashed bag of words. It knows
 * nothing of meaning, but it makes the queue and staleness rules testable.
 * Set `fail` to make it throw (for queries, passages or both), `hang` to make
 * loading never finish, and read `embedded` to see which texts it was given.
 */
export class WordsEmbedder implements Embedder {
  readonly model: string;
  fail: ("query" | "passage")[] = [];
  failLoad = false;
  hang = false;
  embedded: string[] = [];

  constructor(model = "test/words") {
    this.model = model;
  }

  async load() {
    if (this.hang) await new Promise(() => {});
    if (this.failLoad) throw new Error("model files missing");
  }

  async embed(texts: string[], kind: "query" | "passage") {
    if (this.fail.includes(kind)) throw new Error("embedding failed");
    if (kind === "passage") this.embedded.push(...texts);
    return texts.map((t) => {
      const v = new Float32Array(64);
      for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) v[Number(BigInt(Bun.hash(w)) % 64n)] += 1;
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until `check` returns true, or fails after `ms`. */
export async function until(check: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(20);
  }
  throw new Error("condition not met in time");
}
