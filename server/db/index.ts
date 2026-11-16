import { PostgresStore } from "./postgres";
import { SqliteStore } from "./sqlite";
import type { Store } from "./store";

export type { Agent, Doc, Event, Grant, Scope, SectionRow, Store } from "./store";

/** Postgres when the URL starts with "postgres", otherwise a SQLite file. */
export async function openStore(url: string): Promise<Store> {
  const store = /^postgres(ql)?:/.test(url)
    ? new PostgresStore(url)
    : new SqliteStore(url.replace(/^sqlite:(\/\/)?/, ""));
  await store.init();
  return store;
}
