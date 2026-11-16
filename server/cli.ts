#!/usr/bin/env bun
// The command line: serve, service, key, reindex, status, version, update.
import { type ParseArgsConfig, parseArgs } from "node:util";
import { createAgent } from "./access";
import { type Config, ENV_PREFIX, type LoadedConfig, loadConfig } from "./config";
import { openStore } from "./db";
import { UserError } from "./files";
import { requireGit, startServer } from "./index";
import { WorkerEmbedder } from "./index/embed";
import { lockDataDir } from "./lock";
import { Memory } from "./memory";
import { NAME } from "./name";
import { health, localUrl, service } from "./service";
import { update } from "./update";
import { versionLine } from "./version";

const HELP = `${NAME}: a shared memory for agents, as Markdown files with git history.

Usage:
  ${NAME} serve                      run the server in the foreground
  ${NAME} service install            run it in the background and at login, and start it
  ${NAME} service start | stop | restart | status | logs [-f]
  ${NAME} service uninstall          remove the service (data and config stay)
  ${NAME} key create <name> --read <prefix> --write <prefix>
                                     create an agent key (prefixes repeat; / means everything)
  ${NAME} key list
  ${NAME} key revoke <name>
  ${NAME} reindex                    rebuild the search indexes from the files
  ${NAME} status                     where it runs, where the data is, index health
  ${NAME} update                     install the latest release
  ${NAME} version
`;

/**
 * Parses a command's arguments strictly: unknown options and extra words are
 * refused rather than ignored. Returns null after printing the help for -h.
 */
function args(
  argv: string[],
  positionals: number,
  options: ParseArgsConfig["options"] = {},
): { values: Record<string, unknown>; positionals: string[] } | null {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: { ...options, help: { type: "boolean", short: "h" } } });
  } catch (err) {
    throw new UserError("usage", `${(err as Error).message}\n\n${HELP}`);
  }
  if (parsed.values.help) {
    console.log(HELP);
    return null;
  }
  if (parsed.positionals.length > positionals) {
    throw new UserError("usage", `Unexpected argument "${parsed.positionals[positionals]}".\n\n${HELP}`);
  }
  return parsed;
}

function connectHint(c: Config, key = "<key>") {
  return [
    `Connect Claude Code:`,
    `  claude mcp add --transport http ${NAME} ${localUrl(c)}/mcp --header "Authorization: Bearer ${key}"`,
  ].join("\n");
}

function firstRun(config: Config, url: string) {
  console.log(`\nFirst run: created ${config.configFile} with an admin token for the dashboard.`);
  console.log(`Dashboard: ${url} (sign in with ADMIN_TOKEN from that file)`);
  console.log(`Create a key for an agent: ${NAME} key create <name> --write /`);
  console.log(connectHint(config));
}

function requireToken(config: Config) {
  if (!config.adminToken) {
    throw new UserError("config", `ADMIN_TOKEN is empty in ${config.configFile}, so nobody could sign in to the dashboard. Set one, for example: openssl rand -base64 32`);
  }
}

async function serve(config: LoadedConfig) {
  requireToken(config);
  const app = await startServer(config).catch((err) => {
    if (err?.code === "EADDRINUSE") throw new UserError("port", `Port ${config.port} is in use. Is ${NAME} already running? Set another PORT in ${config.configFile}.`);
    throw err;
  });
  const stop = async () => {
    await app.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log(`${versionLine(NAME)} listening on ${app.url}`);
  console.log(`data: ${config.dataDir}`);
  console.log(`database: ${app.store.kind === "sqlite" ? config.databaseUrl : "postgres"}`);
  if (config.created) firstRun(config, app.url);
}

async function key(argv: string[]) {
  const parsed = args(argv, 2, { read: { type: "string", multiple: true }, write: { type: "string", multiple: true } });
  if (!parsed) return;
  const { values, positionals } = parsed;
  const [sub, name] = positionals;
  if (sub === "create" || sub === "revoke") {
    if (!name) throw new UserError("usage", `Give the key's name: ${NAME} key ${sub} <name>`);
  } else if (sub !== "list") {
    throw new UserError("usage", HELP);
  }
  const prefixes = [...((values.read as string[]) ?? []), ...((values.write as string[]) ?? [])];
  // An empty prefix (often an unset shell variable) would mean everything.
  if (prefixes.some((p) => !p.trim())) throw new UserError("bad_grants", "A prefix is empty. Give a folder, or / for everything.");
  const config = loadConfig(process.env, { create: true });
  if (config.created) console.log(`Created ${config.configFile} with a generated admin token.`);
  const store = await openStore(config.databaseUrl);
  try {
    if (sub === "create") {
      const grants = [
        ...((values.read as string[]) ?? []).map((prefix) => ({ prefix, mode: "read" })),
        ...((values.write as string[]) ?? []).map((prefix) => ({ prefix, mode: "write" })),
      ];
      if (!grants.length) throw new UserError("bad_grants", "Give at least one --read or --write prefix (/ means everything).");
      const { agent, key } = await createAgent(store, name, grants);
      console.log(`Created ${agent.name}: ${formatGrants(agent.grants)}`);
      console.log(`\nKey (shown once): ${key}\n`);
      console.log(connectHint(config, key));
    } else if (sub === "list") {
      const agents = await store.listAgents();
      if (!agents.length) console.log(`No keys yet. Create one: ${NAME} key create <name> --write /`);
      for (const a of agents) {
        const state = a.revoked ? "revoked" : a.lastSeenAt ? `last seen ${a.lastSeenAt}` : "never used";
        console.log(`${a.name.padEnd(20)} ${state.padEnd(34)} ${formatGrants(a.grants)}`);
      }
    } else {
      const agent = (await store.listAgents()).find((a) => a.name === name && !a.revoked);
      if (!agent) throw new UserError("not_found", `No active key named "${name}".`);
      await store.updateAgent(agent.id, { revoked: true });
      console.log(`Revoked ${name}.`);
    }
  } finally {
    await store.close();
  }
}

function formatGrants(grants: { prefix: string; mode: string }[]) {
  return grants.map((g) => `${g.mode} ${g.prefix || "/"}`).join(", ") || "no access";
}

async function reindex(config: Config) {
  requireGit();
  // Held for the whole rebuild: a server on this folder refuses to start meanwhile, and a running one stops this.
  const unlock = lockDataDir(config.dataDir);
  try {
    const store = await openStore(config.databaseUrl);
    await store.resetIndex();
    const embedder = config.embedModel === "off" ? null : new WorkerEmbedder(config.embedModel, config.modelsDir);
    const memory = await Memory.open({ dataDir: config.dataDir, maxFileBytes: config.maxFileBytes, store, embedder });
    const { docs, sections } = await store.counts();
    console.log(`Word index rebuilt: ${docs} files, ${sections} sections.`);
    if (embedder) {
      const timer = setInterval(() => {
        const s = memory.embeddings.status();
        console.log(`embedding: ${s.embedded} / ${s.total}`);
      }, 2000);
      await memory.embeddings.settle();
      clearInterval(timer);
      const s = memory.embeddings.status();
      console.log(
        s.queued === 0
          ? `Meaning index rebuilt: ${s.embedded} sections with ${s.model}.`
          : `Meaning index: ${s.embedded} / ${s.total} (${s.lastError}). The rest is embedded when the server runs.`,
      );
    }
    await memory.close();
    await store.close();
  } finally {
    unlock();
  }
}

async function status(config: Config): Promise<number> {
  console.log(versionLine(NAME));
  console.log(`config:   ${config.configFile}`);
  console.log(`data:     ${config.dataDir}`);
  console.log(`database: ${/^postgres/.test(config.databaseUrl) ? "postgres" : config.databaseUrl}`);
  const h = await health(config);
  if (!h) {
    console.log(`server:   not running at ${localUrl(config)}`);
    return 1;
  }
  if (!h.ok) {
    console.log(`server:   ${localUrl(config)} answered ${h.status} (is ADMIN_TOKEN the same?)`);
    return 1;
  }
  const e = h.embed;
  console.log(`server:   ${localUrl(config)} (dashboard and /mcp), version ${h.version}`);
  console.log(
    `search:   words ok; meaning ${e.model === "off" ? "off" : e.loaded ? "ok" : "unavailable"} ` +
      `(${e.model}, ${e.embedded} / ${e.total} sections embedded, ${e.queued} queued)`,
  );
  if (e.lastError) console.log(`last error: ${e.lastError}`);
  if (e.warning) console.log(`warning:  ${e.warning}`);
  return 0;
}

async function serviceCommand(argv: string[]) {
  const parsed = args(argv, 1, { follow: { type: "boolean", short: "f" } });
  if (!parsed) return;
  const sub = parsed.positionals[0];
  const create = sub === "install";
  const config = loadConfig(process.env, { create });
  if (sub === "install") {
    // The service reads only the config file: a setting given in this shell would be lost (another port or data folder).
    const moved = config.overrides.filter((k) => k !== `${ENV_PREFIX}ADMIN_TOKEN` || !config.created);
    if (moved.length) {
      throw new UserError(
        "config",
        `The service reads its settings from ${config.configFile} only. Put ${moved.map((k) => k.slice(ENV_PREFIX.length)).join(", ")} there ` +
          `instead of ${moved.join(", ")} in the environment` +
          ` (a second instance gets its own file: ${ENV_PREFIX}CONFIG_FILE=<file> ${NAME} service install).`,
      );
    }
    requireToken(config);
    if (config.created) console.log(`Created ${config.configFile} with a generated admin token.`);
  }
  const svc = service(config);
  if (sub === "install") {
    await svc.install();
    console.log(`Installed and started. Dashboard: ${localUrl(config)}`);
    if (config.created) firstRun(config, localUrl(config));
    return;
  }
  if (sub === "uninstall") {
    await svc.uninstall();
    return console.log(`Removed the service. Data (${config.dataDir}) and config (${config.configFile}) stay.`);
  }
  if (sub === "start") return svc.start();
  if (sub === "stop") return svc.stop();
  if (sub === "restart") return svc.restart();
  if (sub === "status") return void (process.exitCode = await svc.status());
  if (sub === "logs") return svc.logs(Boolean(parsed.values.follow));
  throw new UserError("usage", HELP);
}

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") return console.log(HELP);
  if (cmd === "version" || cmd === "--version" || cmd === "-v") return args(rest, 0) && console.log(versionLine(NAME));
  // Only the commands that need a config create one, so the first-run hints show where they belong.
  switch (cmd) {
    case "serve":
      return args(rest, 0) && serve(loadConfig(process.env, { create: true }));
    case "service":
      return serviceCommand(rest);
    case "key":
      return key(rest);
    case "reindex":
      return args(rest, 0) && reindex(loadConfig());
    case "status":
      if (args(rest, 0)) process.exitCode = await status(loadConfig());
      return;
    case "update":
      return args(rest, 0) && update(loadConfig());
    default:
      throw new UserError("usage", `Unknown command "${cmd}".\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof UserError || err instanceof Error ? err.message : String(err));
  process.exit(1);
});
