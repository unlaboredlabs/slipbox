// The Markdown files on disk: path rules, size caps, per-path locks.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { PROFILE_MAX_BYTES } from "./config";

export class UserError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const SEGMENT = /^[a-z0-9_-][a-z0-9._-]*$/;

/**
 * Normalises a folder path: "" for the root, otherwise "a/b/" with a
 * trailing slash. Throws on anything outside the path rules.
 */
export function dirPath(input: string | undefined): string {
  const p = (input ?? "").trim().replace(/\/+$/, "");
  if (p === "" || p === ".") return "";
  checkSegments(p);
  if (p.endsWith(".md")) throw new UserError("bad_path", `"${input}" is a file, not a folder.`);
  return p + "/";
}

/** Validates a file path: lowercase segments, ending in .md. */
export function filePath(input: string | undefined): string {
  const p = (input ?? "").trim();
  checkSegments(p);
  if (!p.endsWith(".md") || p.endsWith("/.md")) throw new UserError("bad_path", `"${p}" must end in .md.`);
  return p;
}

function checkSegments(p: string) {
  if (p.startsWith("/")) throw new UserError("bad_path", `"${p}" is absolute; paths are relative, like shared/notes.md.`);
  for (const seg of p.split("/")) {
    if (seg === "." || seg === ".." || !SEGMENT.test(seg)) {
      throw new UserError(
        "bad_path",
        `"${p}" is not a valid path: use lowercase segments of a-z, 0-9, ".", "_" and "-", separated by "/".`,
      );
    }
  }
}

export function isProfile(path: string): boolean {
  return path === "profile.md" || path.endsWith("/profile.md");
}

/** Content hash, the same as git's blob id, so a version names a git object. */
export function versionOf(content: string | Uint8Array): string {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

export function byteLength(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

/** A queue of async locks keyed by name: callers with the same key run one at a time. */
export class Locks {
  private tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const result = prev.then(fn, fn);
    const tail = result.catch(() => {});
    this.tails.set(key, tail);
    tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}

export interface FileEntry {
  name: string;
  path: string;
  type: "dir" | "file";
}

function isDanglingLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

export class Files {
  readonly root: string;

  constructor(
    dir: string,
    public maxFileBytes: number,
  ) {
    mkdirSync(dir, { recursive: true });
    this.root = realpathSync(dir);
  }

  /** The absolute path for a checked relative path, refusing symlinks that lead outside the folder. */
  abs(rel: string): string {
    const full = join(this.root, rel);
    // Resolve the nearest existing ancestor (or the path itself, following
    // symlinks) and make sure it is still inside root.
    let probe = full;
    while (!existsSync(probe) && probe !== this.root) {
      if (isDanglingLink(probe)) throw new UserError("bad_path", `"${rel}" is a broken link.`);
      probe = dirname(probe);
    }
    const real = realpathSync(probe);
    if (real !== this.root && !real.startsWith(this.root + sep)) {
      throw new UserError("bad_path", `"${rel}" leads outside the data folder.`);
    }
    return full;
  }

  checkSize(path: string, content: string) {
    const bytes = byteLength(content);
    const cap = isProfile(path) ? PROFILE_MAX_BYTES : this.maxFileBytes;
    if (bytes > cap) {
      const what = isProfile(path)
        ? "A profile.md holds only the short, always-current facts: condense it."
        : "Split it into smaller notes by topic, or condense it.";
      throw new UserError("too_large", `${path} would be ${bytes} bytes; the cap is ${cap} bytes. ${what}`, 413);
    }
  }

  async read(path: string): Promise<string | null> {
    const full = this.abs(path);
    if (!existsSync(full)) return null;
    if (!statSync(full).isFile()) return null;
    return await Bun.file(full).text();
  }

  async write(path: string, content: string) {
    const full = this.abs(path);
    mkdirSync(dirname(full), { recursive: true });
    await Bun.write(full, content);
  }

  remove(path: string) {
    const full = this.abs(path);
    rmSync(full, { force: true });
    // Remove folders left empty, up to the root.
    let dir = dirname(full);
    while (dir !== this.root && dir.startsWith(this.root) && readdirSync(dir).length === 0) {
      rmSync(dir, { recursive: true });
      dir = dirname(dir);
    }
  }

  mtime(path: string): string {
    return statSync(this.abs(path)).mtime.toISOString();
  }

  /** Immediate children of a folder ("" or "a/b/"), skipping hidden and invalid names. */
  children(dir: string): FileEntry[] {
    const full = this.abs(dir);
    if (!existsSync(full) || !statSync(full).isDirectory()) return [];
    const out: FileEntry[] = [];
    for (const d of readdirSync(full, { withFileTypes: true })) {
      if (!SEGMENT.test(d.name)) continue;
      const isDir = d.isDirectory() || (d.isSymbolicLink() && statSync(join(full, d.name)).isDirectory());
      if (isDir) out.push({ name: d.name, path: dir + d.name + "/", type: "dir" });
      else if (d.name.endsWith(".md")) out.push({ name: d.name, path: dir + d.name, type: "file" });
    }
    return out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  }

  /** Every valid .md path under the root, for reconciling. */
  allFiles(dir = ""): string[] {
    const out: string[] = [];
    for (const e of this.children(dir)) {
      if (e.type === "dir") {
        try {
          this.abs(e.path);
          out.push(...this.allFiles(e.path));
        } catch {
          // a folder symlinked outside the data folder is ignored
        }
      } else out.push(e.path);
    }
    return out;
  }
}
