#!/usr/bin/env bun
// The command line: serve, service, key, reindex, status, version, update.
import { parseArgs } from "node:util";
import { createAgent } from "./access";
import { type Config, loadConfig } from "./config";
import { openStore } from "./db";
import { UserError } from "./files";
import { startServer } from "./index";
import { LocalEmbedder } from "./index/embed";
import { Memory } from "./memory";
import { NAME } from "./name";
import { service } from "./service";
import { update } from "./update";
import { versionLine } from "./version";

const HELP = `${NAME}: a shared memory for agents, as Markdown files with git history.

Usage:
  ${NAME} serve                      run the server in the foreground
  ${NAME} service install            run it in the background and at login, and start it
  ${NAME} service start | stop | status | logs [-f]
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

const localUrl = (c: Config) => `http://${c.host === "0.0.0.0" || c.host === "::" ? "127.0.0.1" : c.host}:${c.port}`;

function connectHint(c: Config, key = "<key>") {
  return [
    `Connect Claude Code:`,
    `  claude mcp add --transport http ${NAME} ${localUrl(c)}/mcp --header "Authorization: Bearer ${key}"`,
  ].join("\n");
}

async function health(c: Config): Promise<any | null> {
  try {
    const res = await fetch(`${localUrl(c)}/api/health`, {
      headers: { Authorization: `Bearer ${c.adminToken}` },
      signal: AbortSignal.timeout(2000),
    });
    return res.ok ? await res.json() : { ok: false, status: res.status };
  } catch {
    return null;
  }
}

async function serve(config: Config & { created: boolean }) {
  const app = await startServer(config);
  console.log(`${versionLine(NAME)} listening on ${app.url}`);
  console.log(`data: ${config.dataDir}`);
  console.log(`database: ${app.store.kind === "sqlite" ? config.databaseUrl : "postgres"}`);
  if (config.created) {
    console.log(`\nFirst run: created ${config.configFile} with an admin token for the dashboard.`);
    console.log(`Dashboard: ${app.url} (sign in with ADMIN_TOKEN from that file)`);
    console.log(`Create a key for an agent: ${NAME} key create <name> --write /`);
    console.log(connectHint(config));
  }
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await app.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function key(config: Config, args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { read: { type: "string", multiple: true }, write: { type: "string", multiple: true } },
  });
  const [sub, name] = positionals;
  const store = await openStore(config.databaseUrl);
  try {
    if (sub === "create") {
      const grants = [
        ...(values.read ?? []).map((prefix) => ({ prefix, mode: "read" })),
        ...(values.write ?? []).map((prefix) => ({ prefix, mode: "write" })),
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
        console.log(`${a.name.padEnd(20)} ${formatGrants(a.grants).padEnd(40)} ${state}`);
      }
    } else if (sub === "revoke") {
      const agent = (await store.listAgents()).find((a) => a.name === name && !a.revoked);
      if (!agent) throw new UserError("not_found", `No active key named "${name}".`);
      await store.updateAgent(agent.id, { revoked: true });
      console.log(`Revoked ${name}.`);
    } else {
      throw new UserError("usage", HELP);
    }
  } finally {
    await store.close();
  }
}

function formatGrants(grants: { prefix: string; mode: string }[]) {
  return grants.map((g) => `${g.mode} ${g.prefix || "/"}`).join(", ") || "no access";
}

async function reindex(config: Config) {
  if (await health(config)) {
    throw new UserError("running", `${NAME} is running at ${localUrl(config)}. Stop it first (${NAME} service stop), then reindex.`);
  }
  const store = await openStore(config.databaseUrl);
  await store.resetIndex();
  const embedder = config.embedModel === "off" ? null : new LocalEmbedder(config.embedModel, config.modelsDir);
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
}

async function status(config: Config) {
  console.log(versionLine(NAME));
  console.log(`config:   ${config.configFile}`);
  console.log(`data:     ${config.dataDir}`);
  console.log(`database: ${/^postgres/.test(config.databaseUrl) ? "postgres" : config.databaseUrl}`);
  const h = await health(config);
  if (!h) return console.log(`server:   not running at ${localUrl(config)}`);
  if (!h.ok) return console.log(`server:   ${localUrl(config)} answered ${h.status} (is ADMIN_TOKEN the same?)`);
  const e = h.embed;
  console.log(`server:   ${localUrl(config)} (dashboard and /mcp), version ${h.version}`);
  console.log(
    `search:   words ok; meaning ${e.model === "off" ? "off" : e.loaded ? "ok" : "unavailable"} ` +
      `(${e.model}, ${e.embedded} / ${e.total} sections embedded, ${e.queued} queued)`,
  );
  if (e.lastError) console.log(`last error: ${e.lastError}`);
}

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") return console.log(HELP);
  if (cmd === "version" || cmd === "--version" || cmd === "-v") return console.log(versionLine(NAME));
  const config = loadConfig();
  if (config.created && cmd !== "serve") console.log(`Created ${config.configFile} with a generated admin token.`);
  switch (cmd) {
    case "serve":
      return serve(config);
    case "service": {
      const svc = service(config);
      const sub = rest[0];
      if (sub === "install") {
        await svc.install();
        console.log(`Installed and started. Dashboard: ${localUrl(config)}`);
        return;
      }
      if (sub === "uninstall") {
        await svc.uninstall();
        return console.log(`Removed the service. Data (${config.dataDir}) and config (${config.configFile}) stay.`);
      }
      if (sub === "start") return svc.start();
      if (sub === "stop") return svc.stop();
      if (sub === "status") return svc.status();
      if (sub === "logs") return svc.logs(rest.includes("-f") || rest.includes("--follow"));
      throw new UserError("usage", HELP);
    }
    case "key":
      return key(config, rest);
    case "reindex":
      return reindex(config);
    case "status":
      return status(config);
    case "update":
      return update(config);
    default:
      throw new UserError("usage", `Unknown command "${cmd}".\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof UserError || err instanceof Error ? err.message : String(err));
  process.exit(1);
});
