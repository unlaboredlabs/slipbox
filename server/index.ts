// One Bun process, one port: /mcp for agents, /api for the dashboard, / for the dashboard's files.
import { apiHandler, error } from "./api";
import type { Config } from "./config";
import { openStore } from "./db";
import { type Embedder, LocalEmbedder } from "./index/embed";
import { handleMcp } from "./mcp";
import { Memory } from "./memory";
import { serveWeb } from "./web";

/** Starts the server. Tests may pass their own embedder. */
export async function startServer(config: Config, opts: { embedder?: Embedder | null } = {}) {
  const store = await openStore(config.databaseUrl);
  const embedder =
    opts.embedder !== undefined
      ? opts.embedder
      : config.embedModel === "off"
        ? null
        : new LocalEmbedder(config.embedModel, config.modelsDir);
  const memory = await Memory.open({
    dataDir: config.dataDir,
    maxFileBytes: config.maxFileBytes,
    store,
    embedder,
    watch: true,
  });
  const api = apiHandler(memory, config.adminToken);

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: 120,
    async fetch(req, server) {
      const { pathname } = new URL(req.url);
      try {
        if (pathname === "/mcp") return await handleMcp(req, memory);
        if (pathname === "/api" || pathname.startsWith("/api/")) return await api(req, server);
        return serveWeb(req);
      } catch (err) {
        return error(err);
      }
    },
  });

  return {
    server,
    memory,
    store,
    url: `http://${config.host.includes(":") ? `[${config.host}]` : config.host}:${server.port}`,
    async stop() {
      server.stop(true);
      await memory.close();
      await store.close();
    },
  };
}
