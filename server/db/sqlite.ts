import { SQL } from "bun";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Section } from "../index/sections";
import { fts5Query } from "../index/words";
import { type Doc, type Scope, Store } from "./store";

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

const SCHEMA = `
pragma journal_mode = wal;
pragma busy_timeout = 5000;
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

// Column weights for bm25(): title, heading, text.
const WEIGHTS = "4.0, 2.0, 1.0";

export class SqliteStore extends Store {
  readonly kind = "sqlite" as const;

  constructor(filename: string) {
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
    super(new SQL({ adapter: "sqlite", filename }));
  }

  async init() {
    await this.exec(SCHEMA);
  }

  async resetIndex() {
    await this.exec("drop table if exists sections_fts; drop table if exists sections; drop table if exists docs; drop table if exists embeddings");
    await this.exec(INDEX_SCHEMA);
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

  async wordSearch(terms: string[], scope: Scope, limit: number): Promise<number[]> {
    if (!terms.length) return [];
    const where = this.scopeCondition("s.doc_path", scope, 1);
    const rows = await this.sql.unsafe(
      `select s.id from sections_fts f join sections s on s.id = f.rowid
       where sections_fts match ? and ${where.sql}
       order by bm25(sections_fts, ${WEIGHTS}) limit ${Number(limit)}`,
      [fts5Query(terms), ...where.params],
    );
    return rows.map((r: any) => Number(r.id));
  }
}
