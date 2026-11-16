import { SQL } from "bun";
import type { Section } from "../index/sections";
import { tsQuery } from "../index/words";
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
  id integer generated always as identity primary key,
  doc_path text not null,
  heading text not null,
  start_line integer not null,
  end_line integer not null,
  text text not null,
  text_hash text not null,
  tsv tsvector not null
);
create index if not exists sections_doc on sections (doc_path);
create index if not exists sections_hash on sections (text_hash);
create index if not exists sections_tsv on sections using gin (tsv);
create table if not exists embeddings (
  text_hash text not null,
  model text not null,
  dims integer not null,
  vector bytea not null,
  primary key (text_hash, model)
);
`;

const SCHEMA = `
create table if not exists agents (
  id integer generated always as identity primary key,
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
  id integer generated always as identity primary key,
  at text not null,
  agent text not null,
  action text not null,
  path text,
  query text,
  ok integer not null
);
${INDEX_SCHEMA}`;

/**
 * Postgres has no BM25; ts_rank with weights A (title) > B (heading) > D (text)
 * and length normalisation (flag 1) plays the same role.
 */
export class PostgresStore extends Store {
  readonly kind = "postgres" as const;

  constructor(url: string) {
    super(new SQL(url));
  }

  async init() {
    await this.sql.unsafe("set client_min_messages = warning");
    await this.sql.unsafe(SCHEMA);
  }

  async resetIndex() {
    await this.sql.unsafe("drop table if exists sections, docs, embeddings");
    await this.sql.unsafe(INDEX_SCHEMA);
  }

  protected param(i: number) {
    return `$${i + 1}`;
  }

  protected async insertSections(tx: SQL, doc: Doc, sections: Section[]) {
    const ids: number[] = [];
    for (const s of sections) {
      const [row] = await tx`insert into sections (doc_path, heading, start_line, end_line, text, text_hash, tsv)
        values (${doc.path}, ${s.heading}, ${s.startLine}, ${s.endLine}, ${s.text}, ${s.textHash},
          setweight(to_tsvector('english', ${doc.title}), 'A') ||
          setweight(to_tsvector('english', ${s.heading}), 'B') ||
          setweight(to_tsvector('english', ${s.text}), 'D'))
        returning id`;
      ids.push(Number(row.id));
    }
    return ids;
  }

  protected async deleteSections(tx: SQL, path: string) {
    await tx`delete from sections where doc_path = ${path}`;
  }

  async wordSearch(terms: string[], scope: Scope, limit: number): Promise<number[]> {
    if (!terms.length) return [];
    const where = this.scopeCondition("doc_path", scope, 1);
    const rows = await this.sql.unsafe(
      `select id from sections, to_tsquery('english', $1) q
       where tsv @@ q and ${where.sql}
       order by ts_rank(tsv, q, 1) desc, id limit ${Number(limit)}`,
      [tsQuery(terms), ...where.params],
    );
    return rows.map((r: any) => Number(r.id));
  }
}
