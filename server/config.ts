import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { NAME } from "./name";

export interface Config {
  dataDir: string; // the Markdown files, its own git repo
  databaseUrl: string; // "postgres://..." or a SQLite file path
  adminToken: string;
  host: string;
  port: number;
  maxFileBytes: number;
  embedModel: string; // "off" disables meaning search
  modelsDir: string; // where the embedding model is downloaded to
  configFile: string;
  serviceName: string;
}

export const PROFILE_MAX_BYTES = 4 * 1024;

const KEYS = [
  "DATA_DIR",
  "DATABASE_URL",
  "ADMIN_TOKEN",
  "HOST",
  "PORT",
  "MAX_FILE_BYTES",
  "EMBED_MODEL",
  "SERVICE_NAME",
] as const;

export function defaultConfigFile(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, NAME, "config.env");
}

function defaultHome(): string {
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, NAME);
}

export function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** Parses a simple KEY=value file. Lines starting with # are comments. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

/**
 * Loads the config: environment variables override the config file. On the
 * first run the config file is created with a generated admin token, so the
 * program needs no setup.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config & { created: boolean } {
  const configFile = resolve(env.CONFIG_FILE || defaultConfigFile());
  let created = false;
  if (!existsSync(configFile)) {
    mkdirSync(dirname(configFile), { recursive: true });
    const lines = [
      `# ${NAME} configuration. Environment variables override these values.`,
      `ADMIN_TOKEN=${env.ADMIN_TOKEN || newSecret()}`,
      `# DATA_DIR=${join(defaultHome(), "data")}`,
      `# PORT=7323`,
      `# HOST=127.0.0.1`,
      `# DATABASE_URL=postgres://user:pass@localhost/${NAME}`,
      `# EMBED_MODEL=Xenova/bge-small-en-v1.5`,
      "",
    ];
    writeFileSync(configFile, lines.join("\n"), { mode: 0o600 });
    created = true;
  }
  const file = parseEnvFile(readFileSync(configFile, "utf8"));
  const get = (k: (typeof KEYS)[number]) => env[k] || file[k] || "";

  const dataDir = resolve(get("DATA_DIR") || join(defaultHome(), "data"));
  const home = dirname(dataDir);
  return {
    dataDir,
    databaseUrl: get("DATABASE_URL") || join(home, "data.db"),
    adminToken: get("ADMIN_TOKEN"),
    host: get("HOST") || "127.0.0.1",
    port: Number(get("PORT") || 7323),
    maxFileBytes: Number(get("MAX_FILE_BYTES") || 32 * 1024),
    embedModel: get("EMBED_MODEL") || "Xenova/bge-small-en-v1.5",
    modelsDir: join(home, "models"),
    configFile,
    serviceName: get("SERVICE_NAME") || NAME,
    created,
  };
}
