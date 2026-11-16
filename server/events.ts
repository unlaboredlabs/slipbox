// The activity log: stored in the database and pushed live to subscribers.
import type { Event, Store } from "./db";

export class EventLog {
  private listeners = new Set<(e: Event) => void>();

  constructor(private store: Store) {}

  async log(e: Omit<Event, "id" | "at">): Promise<Event | null> {
    try {
      const event = await this.store.addEvent(e);
      for (const fn of this.listeners) fn(event);
      return event;
    } catch (err) {
      // Logging must never break the call it records.
      console.error("could not log event:", err);
      return null;
    }
  }

  subscribe(fn: (e: Event) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
