// Agent keys and path-prefix grants.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Agent, Grant, Scope, Store } from "./db";
import { UserError, dirPath } from "./files";

/** Who is calling: an agent with grants, or the admin (the dashboard), who may do anything. */
export interface Caller {
  name: string;
  grants: Grant[] | null; // null = admin
}

export const ADMIN: Caller = { name: "admin", grants: null };

export function newKey(): string {
  return "sk_" + randomBytes(32).toString("base64url");
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function sameSecret(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}

/** Names the server writes as itself: the dashboard, and changes made outside. */
const RESERVED = ["admin", "outside"];

export function checkAgentName(name: unknown): string {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(name.trim())) {
    throw new UserError("bad_name", "An agent name is 1 to 64 letters, digits, spaces, '.', '_' or '-'.");
  }
  if (RESERVED.includes(name.trim().toLowerCase())) {
    throw new UserError("bad_name", `"${name.trim()}" is reserved: it marks the dashboard's and outside changes. Pick another name.`);
  }
  return name.trim();
}

/** Validates grants from user input: prefixes are folders ("" or "/" means everything). */
export function checkGrants(input: unknown): Grant[] {
  if (!Array.isArray(input)) throw new UserError("bad_grants", "grants must be a list of { prefix, mode }.");
  const out = new Map<string, Grant>();
  for (const g of input) {
    if (!g || typeof g.prefix !== "string" || (g.mode !== "read" && g.mode !== "write")) {
      throw new UserError("bad_grants", 'Each grant is { prefix: "shared/", mode: "read" | "write" }.');
    }
    const prefix = g.prefix.trim() === "/" ? "" : dirPath(g.prefix);
    // write includes read; keep the stronger mode when a prefix is listed twice
    if (out.get(prefix)?.mode !== "write") out.set(prefix, { prefix, mode: g.mode });
  }
  return [...out.values()];
}

export function canRead(caller: Caller, path: string): boolean {
  return caller.grants === null || caller.grants.some((g) => path.startsWith(g.prefix));
}

export function canWrite(caller: Caller, path: string): boolean {
  return caller.grants === null || caller.grants.some((g) => g.mode === "write" && path.startsWith(g.prefix));
}

/** A folder is visible if it is readable or leads down to a readable prefix. */
export function canSeeDir(caller: Caller, dir: string): boolean {
  return caller.grants === null || caller.grants.some((g) => dir.startsWith(g.prefix) || g.prefix.startsWith(dir));
}

export function readScope(caller: Caller): Scope {
  return caller.grants === null ? null : caller.grants.map((g) => g.prefix);
}

export function requireRead(caller: Caller, path: string) {
  if (!canRead(caller, path)) {
    throw new UserError("forbidden", `This key may not read ${path}. It may read: ${prefixes(caller, ["read", "write"])}.`, 403);
  }
}

export function requireWrite(caller: Caller, path: string) {
  if (!canWrite(caller, path)) {
    throw new UserError("forbidden", `This key may not write ${path}. It may write: ${prefixes(caller, ["write"])}.`, 403);
  }
}

function prefixes(caller: Caller, modes: Grant["mode"][]): string {
  const list = (caller.grants ?? []).filter((g) => modes.includes(g.mode)).map((g) => g.prefix || "/");
  return list.length ? list.join(", ") : "nothing";
}

/** Creates an agent and its key. The key is returned once and only its hash is stored. */
export async function createAgent(store: Store, name: unknown, grants: unknown): Promise<{ agent: Agent; key: string }> {
  const clean = checkAgentName(name);
  const checked = checkGrants(grants ?? []);
  if ((await store.listAgents()).some((a) => a.name.toLowerCase() === clean.toLowerCase() && !a.revoked)) {
    throw new UserError("exists", `An agent named "${clean}" already exists.`, 409);
  }
  const key = newKey();
  return { agent: await store.createAgent(clean, hashKey(key), checked), key };
}
