import { SQL } from "bun";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { Locks } from "../files";
import type { Section } from "../index/sections";
import { fts5Query } from "../index/words";
import { type Doc, type Scope, type SectionRow, Store, toSection } from "./store";

const INDEX_SCHEMA = `
create table if not exists docs (
  path text primary key,
  title text not null,
  summary text not null,
  hash text not null,
  bytes integer not null,
  updated_at text not null
);
create table if not exists sections (
  id integer primary key autoincrement,
  doc_path text not null,
  heading text not null,
  start_line integer not null,
  end_line integer not null,
  text text not null,
  text_hash text not null
);
create index if not exists sections_doc on sections (doc_path);
create index if not exists sections_hash on sections (text_hash);
create virtual table if not exists sections_fts using fts5 (title, heading, text, tokenize = 'porter unicode61');
create table if not exists embeddings (
  text_hash text not null,
  model text not null,
  dims integer not null,
  vector blob not null,
  primary key (text_hash, model)
);
`;

// The busy timeout comes first: every statement after it, including the switch
// to WAL, then waits for another process's write (the CLI beside a running
// server) instead of failing with "database is locked".
const SCHEMA = `
pragma busy_timeout = 10000;
pragma journal_mode = wal;
pragma synchronous = normal;
pragma foreign_keys = on;
create table if not exists agents (
  id integer primary key autoincrement,
  name text not null,
  key_hash text not null unique,
  created_at text not null,
  last_seen_at text,
  revoked integer not null default 0
);
create table if not exists grants (
  agent_id integer not null references agents (id) on delete cascade,
  prefix text not null,
  mode text not null,
  primary key (agent_id, prefix)
);
create table if not exists events (
  id integer primary key autoincrement,
  at text not null,
  agent text not null,
  action text not null,
  path text,
  query text,
  ok integer not null
);
${INDEX_SCHEMA}`;

/**
 * Bun's SQLite client has one connection per process, so a query run while a
 * transaction is open would see (and join) its unfinished work. Queueing every
 * query and transaction makes each transaction atomic to the rest of the
 * process. Inside a transaction, use its `tx`, never the store's `sql`.
 */
function oneAtATime(sql: SQL): SQL {
  const locks = new Locks();
  const run = <T>(fn: () => T) => locks.run("db", async () => await fn());
  const queued: any = (strings: TemplateStringsArray, ...values: unknown[]) => run(() => sql(strings, ...values));
  queued.unsafe = (query: string, params?: unknown[]) => run(() => sql.unsafe(query, params));
  queued.begin = (...args: unknown[]) => run(() => (sql.begin as any)(...args));
  queued.close = () => sql.close();
  return queued as SQL;
}

// Column weights for bm25(): title, heading, text.
const WEIGHTS = "4.0, 2.0, 1.0";

export class SqliteStore extends Store {
  readonly kind = "sqlite" as const;

  constructor(private filename: string) {
    if (filename !== ":memory:") {
      mkdirSync(dirname(filename), { recursive: true });
      // Keys, the index and the activity log are for this user only. SQLite
      // gives the -wal and -shm files the database file's mode.
      if (!existsSync(filename)) closeSync(openSync(filename, "a", 0o600));
      for (const f of [filename, `${filename}-wal`, `${filename}-shm`]) {
        try {
          chmodSync(f, 0o600);
        } catch {}
      }
    }
    super(oneAtATime(new SQL({ adapter: "sqlite", filename })));
  }

  async init() {
    try {
      await this.exec(SCHEMA);
    } catch (err) {
      if (!/malformed|not a database/i.test(String(err))) throw err;
      throw new Error(
        `${this.filename} is damaged (${err instanceof Error ? err.message : err}). Stop the server and move it aside: ` +
          "the search index rebuilds from the files at the next start, but agent keys must be created again.",
      );
    }
  }

  async resetIndex() {
    await this.exec("drop table if exists sections_fts; drop table if exists sections; drop table if exists docs; drop table if exists embeddings");
    await this.exec(INDEX_SCHEMA);
  }

  // BEGIN IMMEDIATE takes the write lock up front. A deferred transaction that
  // reads and then writes cannot wait for the lock in WAL mode: it fails at once.
  protected transaction<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
    return this.sql.begin("immediate", fn) as Promise<T>;
  }

  protected param(_i: number) {
    return "?";
  }

  protected async insertSections(tx: SQL, doc: Doc, sections: Section[]) {
    const ids: number[] = [];
    for (const s of sections) {
      const [row] = await tx`insert into sections (doc_path, heading, start_line, end_line, text, text_hash)
        values (${doc.path}, ${s.heading}, ${s.startLine}, ${s.endLine}, ${s.text}, ${s.textHash}) returning id`;
      await tx`insert into sections_fts (rowid, title, heading, text) values (${row.id}, ${doc.title}, ${s.heading}, ${s.text})`;
      ids.push(Number(row.id));
    }
    return ids;
  }

  protected async deleteSections(tx: SQL, path: string) {
    await tx`delete from sections_fts where rowid in (select id from sections where doc_path = ${path})`;
    await tx`delete from sections where doc_path = ${path}`;
  }

  async wordSearch(terms: string[], scope: Scope, limit: number): Promise<SectionRow[]> {
    if (!terms.length) return [];
    const where = this.scopeCondition("s.doc_path", scope, 1);
    const rows = await this.sql.unsafe(
      `select s.* from sections_fts f join sections s on s.id = f.rowid
       where sections_fts match ? and ${where.sql}
       order by bm25(sections_fts, ${WEIGHTS}) limit ${Number(limit)}`,
      [fts5Query(terms), ...where.params],
    );
    return rows.map(toSection);
  }
}
