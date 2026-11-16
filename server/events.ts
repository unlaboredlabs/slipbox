// The activity log: stored in the database and pushed live to subscribers.
import type { Event, Store } from "./db";

/** Longest path or query kept in an event: the log is for watching, not a copy of every request. */
const MAX_TEXT = 500;
/** Events kept; older ones are dropped at start and once a day. */
export const KEEP_EVENTS = 100_000;

const cut = (s: string | null) => (s !== null && s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + "…" : s);

export class EventLog {
  private listeners = new Set<(e: Event) => void>();

  constructor(private store: Store) {}

  async log(e: Omit<Event, "id" | "at">): Promise<Event | null> {
    try {
      const event = await this.store.addEvent({ ...e, path: cut(e.path), query: cut(e.query) });
      for (const fn of this.listeners) fn(event);
      return event;
    } catch (err) {
      // Logging must never break the call it records.
      console.error("could not log event:", err);
      return null;
    }
  }

  async prune(keep = KEEP_EVENTS) {
    try {
      await this.store.pruneEvents(keep);
    } catch (err) {
      console.error("could not prune events:", err);
    }
  }

  subscribe(fn: (e: Event) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
