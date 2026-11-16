// The Markdown files on disk: path rules, size caps, per-path locks.
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { PROFILE_MAX_BYTES } from "./config";
import { NAME } from "./name";

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
const MAX_SEGMENT = 100;
const MAX_PATH = 512;

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
  if (p.length > MAX_PATH) throw new UserError("bad_path", `The path is ${p.length} characters; the cap is ${MAX_PATH}.`);
  const segs = p.split("/");
  segs.forEach((seg, i) => {
    if (seg === "." || seg === ".." || !SEGMENT.test(seg)) {
      throw new UserError(
        "bad_path",
        `"${p}" is not a valid path: use lowercase segments of a-z, 0-9, ".", "_" and "-", separated by "/".`,
      );
    }
    if (seg.length > MAX_SEGMENT) {
      throw new UserError("bad_path", `"${seg.slice(0, 20)}..." is ${seg.length} characters; a name's cap is ${MAX_SEGMENT}.`);
    }
    if (i < segs.length - 1 && seg.endsWith(".md")) {
      throw new UserError("bad_path", `"${p}": a folder name cannot end in .md.`);
    }
  });
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

  /** Resolves once every queued and running call has finished, or after `ms`. */
  async drain(ms: number) {
    const end = Date.now() + ms;
    while (this.tails.size && Date.now() < end) {
      await Promise.race([Promise.all(this.tails.values()), Bun.sleep(Math.max(0, end - Date.now()))]);
    }
  }
}

export interface FileEntry {
  name: string;
  path: string;
  type: "dir" | "file";
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export class Files {
  readonly root: string;

  constructor(
    dir: string,
    public maxFileBytes: number,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700); // notes are for this user only
    } catch {}
    this.root = realpathSync(dir);
  }

  /**
   * The absolute path for a checked relative path. A symlink anywhere below the
   * root is refused: it could lead outside the folder, or around a key's grants.
   */
  abs(rel: string): string {
    let at = this.root;
    for (const part of rel.split("/").filter(Boolean)) {
      at = join(at, part);
      let link: boolean;
      try {
        link = lstatSync(at).isSymbolicLink();
      } catch {
        break; // missing: nothing below it exists
      }
      if (link) throw new UserError("bad_path", `"${rel}" goes through a symlink, which ${NAME} does not follow.`);
    }
    return join(this.root, rel);
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

  /** The file's text, or null if it does not exist. Refuses a file that is not UTF-8 (code not_text). */
  async read(path: string): Promise<string | null> {
    const full = this.abs(path);
    if (!existsSync(full)) return null;
    if (!statSync(full).isFile()) return null;
    const bytes = readFileSync(full);
    try {
      return UTF8.decode(bytes);
    } catch {
      throw new UserError("not_text", `${path} is not UTF-8 text, so ${NAME} will not change it; fix or remove it outside.`, 422, {
        version: versionOf(bytes),
      });
    }
  }

  /** Replaces a file whole: written to a temporary file, flushed, then renamed over it. */
  async write(path: string, content: string) {
    const full = this.abs(path);
    const dir = dirname(full);
    mkdirSync(dir, { recursive: true });
    // A hidden name, so the watcher and the path rules ignore it.
    const tmp = join(dir, `.${basename(full)}.tmp-${randomBytes(4).toString("hex")}`);
    try {
      const fd = openSync(tmp, "w");
      try {
        const bytes = Buffer.from(content, "utf8");
        for (let off = 0; off < bytes.length; ) off += writeSync(fd, bytes, off);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, full);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    try {
      const fd = openSync(dir, "r");
      try {
        fsyncSync(fd); // the rename itself
      } finally {
        closeSync(fd);
      }
    } catch {}
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

  exists(path: string): boolean {
    return existsSync(this.abs(path));
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
      // Symlinks are skipped (see abs), and so are names no path may have.
      if (!SEGMENT.test(d.name) || d.name.length > MAX_SEGMENT) continue;
      if (d.isDirectory() && !d.name.endsWith(".md")) out.push({ name: d.name, path: dir + d.name + "/", type: "dir" });
      else if (d.isFile() && d.name.endsWith(".md")) out.push({ name: d.name, path: dir + d.name, type: "file" });
    }
    return out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  }

  /** Every valid .md path under the root, for reconciling. */
  allFiles(dir = ""): string[] {
    const out: string[] = [];
    for (const e of this.children(dir)) {
      if (e.type === "dir") out.push(...this.allFiles(e.path));
      else out.push(e.path);
    }
    return out;
  }
}
