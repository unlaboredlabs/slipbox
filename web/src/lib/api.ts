// The dashboard API, as specified in DESIGN.md ("HTTP API for the dashboard").

export type Health = {
  ok: boolean;
  db: string;
  /** The server's version: a release number, or "dev". */
  version: string;
  embed: {
    model: string;
    loaded: boolean;
    embedded: number;
    total: number;
    queued: number;
    lastError: string | null;
  };
};

export type TreeEntry = {
  name: string;
  path: string;
  type: "dir" | "file";
  summary: string;
  bytes: number;
  /** Null for an empty folder. */
  updatedAt: string | null;
};

export type FileDoc = {
  path: string;
  title: string;
  summary: string;
  content: string;
  version: string;
  bytes: number;
  /** Null when reading an old version. */
  updatedAt: string | null;
};

/** `version` is null for the commit that deleted the file. */
export type Version = { version: string | null; commit: string; at: string; agent: string; why: string };

export type SearchResult = {
  path: string;
  heading: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
  wordRank: number | null;
  meaningRank: number | null;
};

export type SearchResponse = { meaning: "ok" | "unavailable"; results: SearchResult[] };

export type ActivityEvent = {
  id: number;
  at: string;
  agent: string;
  action: string;
  path: string | null;
  query: string | null;
  ok: boolean;
};

/** `prefix` is "" for everything, otherwise a folder ending in "/". */
export type Grant = { prefix: string; mode: "read" | "write" };

export type Agent = {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  revoked: boolean;
  grants: Grant[];
};

// The admin token lives in localStorage and goes out as a bearer token.
const TOKEN_KEY = "adminToken";

export const token = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (value: string) => localStorage.setItem(TOKEN_KEY, value),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let onUnauthorized = () => {};
/** Called on any 401, so the app can send the person back to the login screen. */
export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler;
}

// Where the dashboard is mounted: built files live in <base>/assets/, so the API is at <base>/api.
const base = import.meta.env.DEV ? new URL("/", location.origin) : new URL(/* @vite-ignore */ "..", import.meta.url);

export function apiUrl(path: string, params?: Record<string, string | number | undefined | null>) {
  const url = new URL(`api/${path}`, base);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return url;
}

export function authHeaders(override?: string): HeadersInit {
  const value = override ?? token.get();
  return value ? { Authorization: `Bearer ${value}` } : {};
}

async function request<T>(
  method: string,
  path: string,
  options: { params?: Record<string, string | number | undefined | null>; body?: unknown; token?: string } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path, options.params), {
      method,
      headers: {
        ...authHeaders(options.token),
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new ApiError(0, "network", "Can't reach the server");
  }
  if (res.status === 401 && options.token === undefined) onUnauthorized();
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const error = data?.error;
    throw new ApiError(res.status, error?.code ?? "http", error?.message ?? `${res.status} ${res.statusText}`);
  }
  return data as T;
}

export const api = {
  health: (withToken?: string) => request<Health>("GET", "health", { token: withToken }),
  tree: (path: string) => request<{ path: string; entries: TreeEntry[] }>("GET", "tree", { params: { path } }),
  file: (path: string, version?: string) => request<FileDoc>("GET", "file", { params: { path, version } }),
  history: (path: string, limit = 100) =>
    request<{ versions: Version[] }>("GET", "history", { params: { path, limit } }),
  diff: (path: string, from: string | undefined, to: string) =>
    request<{ diff: string }>("GET", "diff", { params: { path, from, to } }),
  restore: (path: string, commit: string) => request<{ version: string }>("POST", "restore", { body: { path, commit } }),
  search: (q: string, path?: string, limit = 20) =>
    request<SearchResponse>("GET", "search", { params: { q, path, limit } }),
  events: (params: { after?: number; limit?: number; agent?: string }) =>
    request<{ events: ActivityEvent[] }>("GET", "events", { params }),
  agents: () => request<{ agents: Agent[] }>("GET", "agents"),
  createAgent: (name: string, grants: Grant[]) =>
    request<{ agent: Agent; key: string }>("POST", "agents", { body: { name, grants } }),
  updateAgent: (id: string, patch: { grants?: Grant[]; revoked?: boolean }) =>
    request<{ agent: Agent }>("PATCH", `agents/${encodeURIComponent(id)}`, { body: patch }),
};

/**
 * Follows /api/events/stream. EventSource can't send a bearer token, so this reads the
 * stream with fetch and parses the server-sent events itself. Reconnects with backoff.
 */
export function followEvents(handlers: {
  onEvent: (event: ActivityEvent) => void;
  onStatus: (live: boolean) => void;
  /** Called each time the stream opens, to fetch anything missed. */
  onOpen: () => void;
}): () => void {
  const controller = new AbortController();
  let attempt = 0;

  async function connect() {
    while (!controller.signal.aborted) {
      try {
        const res = await fetch(apiUrl("events/stream"), {
          headers: { ...authHeaders(), Accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (res.status === 401) return onUnauthorized();
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        handlers.onStatus(true);
        handlers.onOpen();
        attempt = 0;

        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          const messages = buffer.split(/\r?\n\r?\n/);
          buffer = messages.pop() ?? "";
          for (const message of messages) {
            const data = message
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (!data) continue;
            try {
              handlers.onEvent(JSON.parse(data));
            } catch {
              // Not an event (a keep-alive or something unknown): skip it.
            }
          }
        }
      } catch {
        if (controller.signal.aborted) return;
      }
      handlers.onStatus(false);
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, Math.min(15000, 500 * 2 ** attempt)));
    }
  }

  connect();
  return () => controller.abort();
}
