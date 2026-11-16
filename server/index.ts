// One Bun process, one port: /mcp for agents, /api for the dashboard, / for the dashboard's files.
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { apiHandler, error } from "./api";
import type { Config } from "./config";
import { openStore } from "./db";
import { UserError } from "./files";
import { type Embedder, LocalEmbedder } from "./index/embed";
import { lockDataDir } from "./lock";
import { handleMcp } from "./mcp";
import { Memory } from "./memory";
import { NAME } from "./name";
import { serveWeb } from "./web";

/** How long a stop waits for requests in flight (an agent's write) to finish. */
const DRAIN_MS = 10_000;

export function requireGit() {
  if (!Bun.which("git") || Bun.spawnSync(["git", "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode !== 0) {
    throw new UserError(
      "no_git",
      `${NAME} keeps its history with git, which is not installed or not on PATH.` +
        (process.platform === "darwin" ? " Install it with: xcode-select --install" : " Install it with your package manager."),
    );
  }
}

/** Removes what an interrupted model download leaves behind (`<file>.tmp.<pid>.<random>`). */
function removeDownloadLeftovers(dir: string) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) removeDownloadLeftovers(join(dir, e.name));
    else if (/\.tmp\.\d+\.\w+$/.test(e.name)) rmSync(join(dir, e.name), { force: true });
  }
}

/** Starts the server. Tests may pass their own embedder. */
export async function startServer(config: Config, opts: { embedder?: Embedder | null } = {}) {
  requireGit();
  // Before anything touches the folder: a second instance would lose writes (and clear the first one's git locks).
  const unlock = lockDataDir(config.dataDir);
  let store: Awaited<ReturnType<typeof openStore>> | undefined;
  let memory: Memory | undefined;
  try {
    removeDownloadLeftovers(config.modelsDir);
    store = await openStore(config.databaseUrl);
    const embedder =
      opts.embedder !== undefined
        ? opts.embedder
        : config.embedModel === "off"
          ? null
          : new LocalEmbedder(config.embedModel, config.modelsDir);
    memory = await Memory.open({
      dataDir: config.dataDir,
      maxFileBytes: config.maxFileBytes,
      store,
      embedder,
      watch: true,
    });
  } catch (err) {
    await memory?.close().catch(() => {});
    await store?.close().catch(() => {});
    unlock();
    throw err;
  }
  const api = apiHandler(memory, config.adminToken);

  // Requests whose reply is not complete yet: a stop lets them finish.
  let inFlight = 0;
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: config.host,
      port: config.port,
      idleTimeout: 120,
      async fetch(req, server) {
        const { pathname } = new URL(req.url);
        inFlight++;
        try {
          if (pathname === "/mcp") return await handleMcp(req, memory);
          if (pathname === "/api" || pathname.startsWith("/api/")) return await api(req, server);
          return serveWeb(req);
        } catch (err) {
          return error(err);
        } finally {
          inFlight--;
        }
      },
    });
  } catch (err) {
    await memory.close().catch(() => {});
    await store.close().catch(() => {});
    unlock();
    throw err;
  }

  let stopped: Promise<void> | null = null;
  return {
    server,
    memory,
    store,
    url: `http://${config.host.includes(":") ? `[${config.host}]` : config.host}:${server.port}`,
    /** Stops taking requests, lets the ones in flight finish (up to DRAIN_MS), then closes everything. */
    stop() {
      stopped ??= (async () => {
        server.stop(false);
        const end = Date.now() + DRAIN_MS;
        while (inFlight > 0 && Date.now() < end) await Bun.sleep(20);
        server.stop(true); // what is left open: idle keep-alive and event-stream connections
        try {
          await memory.close();
          await store.close();
        } finally {
          unlock();
        }
      })();
      return stopped;
    },
  };
}
