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

/**
 * The environment overrides the config file only under this prefix, so a
 * shell that exports DATABASE_URL or PORT for another project never points
 * slipbox at it.
 */
export const ENV_PREFIX = `${NAME.toUpperCase()}_`;

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

export type LoadedConfig = Config & {
  created: boolean; // the config file was created by this call
  overrides: string[]; // the environment variables that override the file
};

/**
 * Loads the config: SLIPBOX_* environment variables override the config file.
 * With `create`, a missing config file is created with a generated admin
 * token, so the program needs no setup.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  opts: { create?: boolean } = {},
): LoadedConfig {
  const configFile = resolve(env[`${ENV_PREFIX}CONFIG_FILE`] || defaultConfigFile());
  let created = false;
  if (!existsSync(configFile) && opts.create) {
    mkdirSync(dirname(configFile), { recursive: true });
    const lines = [
      `# ${NAME} configuration. ${ENV_PREFIX}* environment variables override these values.`,
      `ADMIN_TOKEN=${env[`${ENV_PREFIX}ADMIN_TOKEN`] || newSecret()}`,
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
  const file = existsSync(configFile) ? parseEnvFile(readFileSync(configFile, "utf8")) : {};
  const overrides = KEYS.filter((k) => env[ENV_PREFIX + k]).map((k) => ENV_PREFIX + k);
  const get = (k: (typeof KEYS)[number]) => env[ENV_PREFIX + k] || file[k] || "";
  const where = (k: (typeof KEYS)[number]) => (env[ENV_PREFIX + k] ? `${ENV_PREFIX}${k}` : `${k} in ${configFile}`);
  const int = (k: (typeof KEYS)[number], fallback: number, min: number, max: number) => {
    const raw = get(k);
    if (!raw) return fallback;
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || n < min || n > max) throw new Error(`${where(k)} must be a whole number from ${min} to ${max}, not "${raw}".`);
    return n;
  };

  const dataDir = resolve(get("DATA_DIR") || join(defaultHome(), "data"));
  const home = dirname(dataDir);
  return {
    dataDir,
    databaseUrl: get("DATABASE_URL") || join(home, "data.db"),
    adminToken: get("ADMIN_TOKEN"),
    host: get("HOST") || "127.0.0.1",
    port: int("PORT", 7323, 0, 65535),
    maxFileBytes: int("MAX_FILE_BYTES", 32 * 1024, 1, 2 ** 31),
    embedModel: get("EMBED_MODEL") || "Xenova/bge-small-en-v1.5",
    modelsDir: join(home, "models"),
    configFile,
    serviceName: get("SERVICE_NAME") || NAME,
    created,
    overrides,
  };
}
