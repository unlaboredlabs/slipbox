// The app follows /api/events/stream once, for every page: it keeps Activity's rows
// current, and refreshes a note, its history and the tree when an agent changes it.
import { useSyncExternalStore } from "react";
import { queryOptions, type Query, type QueryClient } from "@tanstack/react-query";
import { api, followEvents, type ActivityEvent } from "@/lib/api";

const LOAD = 500;
const KEEP = 1000;

/** Recent events, everyone's or one agent's, newest first. */
export const eventsQuery = (agent?: string) =>
  queryOptions({
    queryKey: ["events", agent ?? null] as const,
    queryFn: async () => (await api.events({ limit: LOAD, agent })).events,
    staleTime: Infinity,
  });

/** Merges events newest first, without duplicates, keeping the latest KEEP. */
function merge(current: ActivityEvent[], incoming: ActivityEvent[]) {
  const byId = new Map(current.map((e) => [e.id, e]));
  for (const e of incoming) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => b.id - a.id).slice(0, KEEP);
}

/** When each live event arrived, so Activity can mark rows that just came in. */
export const arrivedAt = new Map<number, number>();

// Null until the first connection attempt ends, then whether the stream is open.
let status: boolean | null = null;
const listeners = new Set<() => void>();
function setStatus(next: boolean | null) {
  status = next;
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));
export const useLive = () => useSyncExternalStore(subscribe, () => status);

const CHANGES = new Set(["write", "edit", "delete", "restore"]);

export function followLive(queryClient: QueryClient): () => void {
  const eventQueries = () => queryClient.getQueryCache().findAll({ queryKey: ["events"] }) as Query<ActivityEvent[]>[];

  /** The query's rows, waiting for its first load when it is still loading (so nothing that arrives meanwhile is lost). */
  async function rows(query: Query<ActivityEvent[]>) {
    if (query.state.data) return query.state.data;
    if (query.state.fetchStatus !== "fetching") return undefined;
    const agent = (query.queryKey[1] as string | null) ?? undefined;
    return queryClient.ensureQueryData(eventsQuery(agent)).catch(() => undefined);
  }

  async function add(query: Query<ActivityEvent[]>, incoming: ActivityEvent[]) {
    const agent = query.queryKey[1] as string | null;
    const mine = incoming.filter((e) => !agent || e.agent === agent);
    if (mine.length && (await rows(query))) queryClient.setQueryData<ActivityEvent[]>(query.queryKey, (current) => current && merge(current, mine));
  }

  // Events are applied in batches, so a burst renders a few times a second rather than once per event.
  let pending: ActivityEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  function flush() {
    timer = undefined;
    const batch = pending;
    pending = [];
    const now = Date.now();
    for (const [id, at] of arrivedAt) if (now - at > 5000) arrivedAt.delete(id);
    for (const e of batch) arrivedAt.set(e.id, now);

    const changed = new Set(batch.filter((e) => e.ok && e.path && CHANGES.has(e.action)).map((e) => e.path!));
    for (const path of changed) {
      queryClient.invalidateQueries({ queryKey: ["file", path] });
      queryClient.invalidateQueries({ queryKey: ["history", path] });
    }
    if (changed.size) queryClient.invalidateQueries({ queryKey: ["tree"] });
    for (const query of eventQueries()) add(query, batch);
  }
  function receive(events: ActivityEvent[]) {
    pending.push(...events);
    timer ??= setTimeout(flush, 250);
  }

  let opened = false;
  const stop = followEvents({
    onEvent: (event) => receive([event]),
    onStatus: setStatus,
    // Fill in what was missed before the stream opened, or while it was down.
    onOpen: async () => {
      if (opened) {
        queryClient.invalidateQueries({ queryKey: ["file"] });
        queryClient.invalidateQueries({ queryKey: ["history"] });
        queryClient.invalidateQueries({ queryKey: ["tree"] });
      }
      opened = true;
      for (const query of eventQueries()) {
        const current = await rows(query);
        if (!current) continue;
        const agent = (query.queryKey[1] as string | null) ?? undefined;
        const { events } = await api.events({ after: current[0]?.id ?? 0, limit: LOAD, agent }).catch(() => ({ events: [] }));
        if (events.length) receive(events);
      }
    },
  });
  return () => {
    stop();
    clearTimeout(timer);
    setStatus(null);
  };
}
