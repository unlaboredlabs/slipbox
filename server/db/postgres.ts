import { SQL } from "bun";
import type { Section } from "../index/sections";
import { tsPhrases, tsQuery, wordText } from "../index/words";
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
    await this.exec(SCHEMA);
  }

  async resetIndex() {
    await this.sql.unsafe("drop table if exists sections, docs, embeddings");
    await this.exec(INDEX_SCHEMA);
  }

  protected async lockDoc(tx: SQL, path: string) {
    await tx`select pg_advisory_xact_lock(hashtext(${path}))`;
  }

  protected param(i: number) {
    return `$${i + 1}`;
  }

  protected async insertSections(tx: SQL, doc: Doc, sections: Section[]) {
    const ids: number[] = [];
    for (const s of sections) {
      const [row] = await tx`insert into sections (doc_path, heading, start_line, end_line, text, text_hash, tsv)
        values (${doc.path}, ${s.heading}, ${s.startLine}, ${s.endLine}, ${s.text}, ${s.textHash},
          setweight(to_tsvector('english', ${wordText(doc.title)}), 'A') ||
          setweight(to_tsvector('english', ${wordText(s.heading)}), 'B') ||
          setweight(to_tsvector('english', ${wordText(s.text)}), 'D'))
        returning id`;
      ids.push(Number(row.id));
    }
    return ids;
  }

  protected async deleteSections(tx: SQL, path: string) {
    await tx`delete from sections where doc_path = ${path}`;
  }

  async wordSearch(terms: string[], scope: Scope, limit: number): Promise<SectionRow[]> {
    if (!terms.length) return [];
    // ts_rank scores a phrase only by its words, so a section with a whole
    // identifier from the query (stg_shop__orders) is ranked first explicitly.
    const phrases = tsPhrases(terms);
    const where = this.scopeCondition("doc_path", scope, phrases ? 2 : 1);
    const rows = await this.sql.unsafe(
      `select id, doc_path, heading, start_line, end_line, text, text_hash from sections, to_tsquery('english', $1) q
       where tsv @@ q and ${where.sql}
       order by ${phrases ? "tsv @@ to_tsquery('english', $2) desc, " : ""}ts_rank(tsv, q, 1) desc, id limit ${Number(limit)}`,
      [tsQuery(terms), ...(phrases ? [phrases] : []), ...where.params],
    );
    return rows.map(toSection);
  }
}
