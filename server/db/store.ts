// The database: one small interface over SQLite and Postgres via Bun's SQL client.
// Everything here except agents and events can be rebuilt from the files.
import { SQL } from "bun";
import type { Section } from "../index/sections";

export interface Doc {
  path: string;
  title: string;
  summary: string;
  hash: string;
  bytes: number;
  updatedAt: string;
}

export interface SectionRow extends Section {
  id: number;
  docPath: string;
}

export interface SectionRef {
  id: number;
  docPath: string;
  textHash: string;
}

export interface Grant {
  prefix: string;
  mode: "read" | "write";
}

export interface Agent {
  id: number;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  revoked: boolean;
  grants: Grant[];
}

export interface Event {
  id: number;
  at: string;
  agent: string;
  action: string;
  path: string | null;
  query: string | null;
  ok: boolean;
}

/** Path prefixes a query may see; null means everything. */
export type Scope = string[] | null;

export abstract class Store {
  abstract readonly kind: "sqlite" | "postgres";

  constructor(protected sql: SQL) {}

  /** Creates the tables if missing. */
  abstract init(): Promise<void>;
  /** Ranked section ids matching the words of a query, best first. */
  abstract wordSearch(terms: string[], scope: Scope, limit: number): Promise<number[]>;
  /** Inserts sections and their word-index rows, returning their ids. */
  protected abstract insertSections(tx: SQL, doc: Doc, sections: Section[]): Promise<number[]>;
  protected abstract deleteSections(tx: SQL, path: string): Promise<void>;
  /** Drops and recreates the rebuildable tables: docs, sections, word index, embeddings. */
  abstract resetIndex(): Promise<void>;

  async close() {
    await this.sql.close();
  }

  /** Runs fn in a transaction. Keep them short: on SQLite, other processes wait for it. */
  protected transaction<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
    return this.sql.begin(fn) as Promise<T>;
  }

  /** Runs a script of statements separated by semicolons (none inside literals). */
  protected async exec(script: string) {
    for (const stmt of script.split(";")) if (stmt.trim()) await this.sql.unsafe(stmt);
  }

  // Docs and sections

  async docHashes(): Promise<Map<string, string>> {
    const rows = await this.sql`select path, hash from docs`;
    return new Map(rows.map((r: any) => [r.path, r.hash]));
  }

  async getDoc(path: string): Promise<Doc | null> {
    const [row] = await this.sql`select * from docs where path = ${path}`;
    return row ? toDoc(row) : null;
  }

  /** Every doc under a folder ("" for all). */
  async docsUnder(dir: string): Promise<Doc[]> {
    const rows = await this.sql`select * from docs where substr(path, 1, ${dir.length}) = ${dir} order by path`;
    return rows.map(toDoc);
  }

  /** Replaces a doc and its sections. Returns the new section ids and the text hashes that were dropped. */
  async putDoc(doc: Doc, sections: Section[]): Promise<{ ids: number[]; dropped: string[] }> {
    return this.transaction(async (tx) => {
      const old = await tx`select text_hash from sections where doc_path = ${doc.path}`;
      await this.deleteSections(tx, doc.path);
      await tx`insert into docs (path, title, summary, hash, bytes, updated_at)
        values (${doc.path}, ${doc.title}, ${doc.summary}, ${doc.hash}, ${doc.bytes}, ${doc.updatedAt})
        on conflict (path) do update set title = excluded.title, summary = excluded.summary,
          hash = excluded.hash, bytes = excluded.bytes, updated_at = excluded.updated_at`;
      const ids = await this.insertSections(tx, doc, sections);
      const kept = new Set(sections.map((s) => s.textHash));
      const dropped = hashesOf(old).filter((h) => !kept.has(h));
      await this.dropUnusedEmbeddings(tx, dropped);
      return { ids, dropped };
    });
  }

  async deleteDoc(path: string): Promise<string[]> {
    return this.transaction(async (tx) => {
      const old = await tx`select text_hash from sections where doc_path = ${path}`;
      await this.deleteSections(tx, path);
      await tx`delete from docs where path = ${path}`;
      const dropped = hashesOf(old);
      await this.dropUnusedEmbeddings(tx, dropped);
      return dropped;
    });
  }

  async sectionRefs(): Promise<SectionRef[]> {
    const rows = await this.sql`select id, doc_path, text_hash from sections`;
    return rows.map((r: any) => ({ id: Number(r.id), docPath: r.doc_path, textHash: r.text_hash }));
  }

  async sectionsById(ids: number[]): Promise<SectionRow[]> {
    if (!ids.length) return [];
    const rows = await this.sql.unsafe(
      `select * from sections where id in (${ids.map((_, i) => this.param(i)).join(", ")})`,
      ids,
    );
    return rows.map((r: any) => ({
      id: Number(r.id),
      docPath: r.doc_path,
      heading: r.heading,
      startLine: Number(r.start_line),
      endLine: Number(r.end_line),
      text: r.text,
      textHash: r.text_hash,
    }));
  }

  async counts(): Promise<{ sections: number; docs: number }> {
    const [r] = await this.sql`select (select count(*) from sections) as s, (select count(*) from docs) as d`;
    return { sections: Number(r.s), docs: Number(r.d) };
  }

  // Embeddings

  async embeddings(model: string): Promise<Map<string, Float32Array>> {
    const rows = await this.sql`select text_hash, vector from embeddings where model = ${model}`;
    const out = new Map<string, Float32Array>();
    for (const r of rows) out.set(r.text_hash, toVector(r.vector));
    return out;
  }

  async putEmbedding(textHash: string, model: string, vector: Float32Array) {
    const bytes = new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
    await this.sql`insert into embeddings (text_hash, model, dims, vector)
      values (${textHash}, ${model}, ${vector.length}, ${bytes})
      on conflict (text_hash, model) do update set dims = excluded.dims, vector = excluded.vector`;
  }

  /** Drops embeddings of other models, and any whose text no longer exists. */
  async pruneEmbeddings(model: string) {
    await this.sql`delete from embeddings where model <> ${model}
      or text_hash not in (select text_hash from sections)`;
  }

  private async dropUnusedEmbeddings(tx: SQL, hashes: string[]) {
    for (const h of hashes) {
      await tx`delete from embeddings where text_hash = ${h}
        and not exists (select 1 from sections where text_hash = ${h})`;
    }
  }

  // Agents and grants

  async createAgent(name: string, keyHash: string, grants: Grant[]): Promise<Agent> {
    const id = await this.transaction(async (tx) => {
      const [row] = await tx`insert into agents (name, key_hash, created_at, revoked)
        values (${name}, ${keyHash}, ${now()}, 0) returning id`;
      for (const g of grants) {
        await tx`insert into grants (agent_id, prefix, mode) values (${row.id}, ${g.prefix}, ${g.mode})`;
      }
      return Number(row.id);
    });
    return (await this.getAgent(id))!;
  }

  async listAgents(): Promise<Agent[]> {
    const rows = await this.sql`select * from agents order by id`;
    const grants = await this.sql`select * from grants order by prefix`;
    return rows.map((r: any) => toAgent(r, grants));
  }

  async getAgent(id: number): Promise<Agent | null> {
    const [row] = await this.sql`select * from agents where id = ${id}`;
    if (!row) return null;
    const grants = await this.sql`select * from grants where agent_id = ${id} order by prefix`;
    return toAgent(row, grants);
  }

  async agentByKeyHash(keyHash: string): Promise<Agent | null> {
    const [row] = await this.sql`select id from agents where key_hash = ${keyHash} and revoked = 0`;
    return row ? this.getAgent(Number(row.id)) : null;
  }

  async updateAgent(id: number, change: { grants?: Grant[]; revoked?: boolean }) {
    await this.transaction(async (tx) => {
      if (change.revoked !== undefined) {
        await tx`update agents set revoked = ${change.revoked ? 1 : 0} where id = ${id}`;
      }
      if (change.grants) {
        await tx`delete from grants where agent_id = ${id}`;
        for (const g of change.grants) {
          await tx`insert into grants (agent_id, prefix, mode) values (${id}, ${g.prefix}, ${g.mode})`;
        }
      }
    });
  }

  async touchAgent(id: number) {
    await this.sql`update agents set last_seen_at = ${now()} where id = ${id}`;
  }

  // Events

  async addEvent(e: Omit<Event, "id" | "at">): Promise<Event> {
    const at = now();
    const [row] = await this.sql`insert into events (at, agent, action, path, query, ok)
      values (${at}, ${e.agent}, ${e.action}, ${e.path}, ${e.query}, ${e.ok ? 1 : 0}) returning id`;
    return { id: Number(row.id), at, ...e };
  }

  /** Newest first; `after` returns only events with a larger id. */
  async events(opts: { after?: number; limit?: number; agent?: string }): Promise<Event[]> {
    const after = opts.after ?? 0;
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    const rows = opts.agent
      ? await this.sql`select * from events where id > ${after} and agent = ${opts.agent} order by id desc limit ${limit}`
      : await this.sql`select * from events where id > ${after} order by id desc limit ${limit}`;
    return rows.map((r: any) => ({
      id: Number(r.id),
      at: r.at,
      agent: r.agent,
      action: r.action,
      path: r.path ?? null,
      query: r.query ?? null,
      ok: Boolean(Number(r.ok)),
    }));
  }

  /** A positional query parameter for unsafe queries (0-based index). */
  protected abstract param(i: number): string;

  /** SQL condition limiting `column` to a scope, with its parameters starting at `offset`. */
  protected scopeCondition(column: string, scope: Scope, offset: number): { sql: string; params: string[] } {
    if (scope === null) return { sql: "1 = 1", params: [] };
    if (!scope.length) return { sql: "1 = 0", params: [] };
    const parts = scope.map((p, i) => `substr(${column}, 1, ${p.length}) = ${this.param(offset + i)}`);
    return { sql: `(${parts.join(" or ")})`, params: scope };
  }
}

export function now(): string {
  return new Date().toISOString();
}

function toDoc(r: any): Doc {
  return {
    path: r.path,
    title: r.title,
    summary: r.summary,
    hash: r.hash,
    bytes: Number(r.bytes),
    updatedAt: r.updated_at,
  };
}

function toAgent(r: any, grants: any[]): Agent {
  return {
    id: Number(r.id),
    name: r.name,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at ?? null,
    revoked: Boolean(Number(r.revoked)),
    grants: grants
      .filter((g) => Number(g.agent_id) === Number(r.id))
      .map((g) => ({ prefix: g.prefix, mode: g.mode })),
  };
}

function hashesOf(rows: any[]): string[] {
  return [...new Set(rows.map((r) => String(r.text_hash)))];
}

function toVector(bytes: Uint8Array): Float32Array {
  // Copy: the driver's buffer may not be 4-byte aligned.
  const copy = new Uint8Array(bytes);
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}
