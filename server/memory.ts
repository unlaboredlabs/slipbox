// The memory: files on disk as the truth, git as history, the database as the index.
// The MCP tools and the dashboard API are thin layers over this class.
import { watch, type FSWatcher } from "node:fs";
import { type Caller, canRead, canSeeDir, readScope, requireRead, requireWrite } from "./access";
import type { Store } from "./db";
import { EventLog } from "./events";
import { Files, Locks, UserError, byteLength, dirPath, filePath, versionOf } from "./files";
import { type Change, Git, oneLine } from "./git";
import { type Embedder, Embeddings } from "./index/embed";
import { parseMarkdown } from "./index/sections";
import { hybridSearch } from "./index/search";
import { NAME } from "./name";

export interface MemoryOptions {
  dataDir: string;
  maxFileBytes: number;
  store: Store;
  embedder: Embedder | null;
  watch?: boolean;
}

export interface Entry {
  name: string;
  path: string;
  type: "dir" | "file";
  summary: string;
  bytes: number;
  updatedAt: string | null;
}

export interface ReadResult {
  path: string;
  title: string;
  summary: string;
  content: string;
  version: string;
  bytes: number;
  updatedAt: string | null;
  lines?: { start: number; end: number; total: number };
}

const OUTSIDE = "outside";
const MAX_QUERY = 2000;
const DAY = 24 * 60 * 60 * 1000;

export class Memory {
  readonly files: Files;
  readonly git: Git;
  readonly embeddings: Embeddings;
  readonly events: EventLog;
  private locks = new Locks();
  private watcher: FSWatcher | null = null;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private pruner: ReturnType<typeof setInterval> | null = null;

  private constructor(
    readonly store: Store,
    opts: MemoryOptions,
  ) {
    this.files = new Files(opts.dataDir, opts.maxFileBytes);
    this.git = new Git(this.files.root);
    this.embeddings = new Embeddings(store, opts.embedder);
    this.events = new EventLog(store);
  }

  static async open(opts: MemoryOptions): Promise<Memory> {
    const m = new Memory(opts.store, opts);
    await m.git.init();
    await m.reconcileAll();
    await m.embeddings.init();
    await m.events.prune();
    m.pruner = setInterval(() => m.events.prune(), DAY);
    m.pruner.unref?.();
    if (opts.watch) m.startWatching();
    return m;
  }

  async close() {
    this.watcher?.close();
    for (const t of this.timers.values()) clearTimeout(t);
    if (this.pruner) clearInterval(this.pruner);
    // Let writes in flight commit, so none is left on disk for the next start to call "outside".
    await this.locks.drain(10_000);
    await this.embeddings.close();
  }

  // Reading

  async start(caller: Caller, path?: string) {
    const target = path?.endsWith(".md") ? filePath(path) : dirPath(path);
    const dir = target.endsWith(".md") ? target.slice(0, target.lastIndexOf("/") + 1) : target;
    const profiles: { path: string; content: string }[] = [];
    const parts = dir.split("/").filter(Boolean);
    const down = parts.map((_, i) => parts.slice(0, i + 1).join("/") + "/profile.md");
    // shared/ is what every agent should know, so its profile comes on every path, after the root's.
    const paths = ["profile.md", ...(parts[0] === "shared" ? [] : ["shared/profile.md"]), ...down];
    for (const p of paths) {
      if (!canRead(caller, p)) continue;
      // A profile that is not text is skipped, so it cannot make start fail.
      const content = await this.files.read(p).catch((err) => (err instanceof UserError && err.code === "not_text" ? null : Promise.reject(err)));
      if (content !== null) profiles.push({ path: p, content });
    }
    return { profiles, map: await this.list(caller, dir) };
  }

  async list(caller: Caller, path?: string): Promise<{ path: string; entries: Entry[] }> {
    const dir = dirPath(path);
    if (!canSeeDir(caller, dir)) throw new UserError("forbidden", `This key may not read ${dir}.`, 403);
    const docs = await this.store.docsUnder(dir);
    const entries: Entry[] = [];
    for (const e of this.files.children(dir)) {
      if (e.type === "file") {
        if (!canRead(caller, e.path)) continue;
        const doc = docs.find((d) => d.path === e.path);
        entries.push({ ...e, summary: doc?.summary ?? "", bytes: doc?.bytes ?? 0, updatedAt: doc?.updatedAt ?? null });
      } else {
        if (!canSeeDir(caller, e.path)) continue;
        const inside = docs.filter((d) => d.path.startsWith(e.path) && canRead(caller, d.path));
        const profile = inside.find((d) => d.path === e.path + "profile.md");
        entries.push({
          ...e,
          summary: profile?.summary ?? "",
          bytes: inside.reduce((n, d) => n + d.bytes, 0),
          updatedAt: inside.reduce<string | null>((t, d) => (!t || d.updatedAt > t ? d.updatedAt : t), null),
        });
      }
    }
    return { path: dir, entries };
  }

  async read(caller: Caller, path: string, opts: { lines?: string; version?: string } = {}): Promise<ReadResult> {
    path = filePath(path);
    requireRead(caller, path);
    let content: string;
    let version: string;
    let updatedAt: string | null = null;
    if (opts.version) {
      ({ content, version } = await this.git.readVersion(path, opts.version));
    } else {
      const current = await this.files.read(path);
      if (current === null) throw new UserError("not_found", `${path} does not exist.`, 404);
      content = current;
      version = versionOf(current);
      updatedAt = (await this.store.getDoc(path))?.updatedAt ?? this.files.mtime(path);
    }
    const { title, summary } = parseMarkdown(content);
    const result: ReadResult = { path, title, summary, content, version, bytes: byteLength(content), updatedAt };
    if (opts.lines) {
      const all = content.split("\n");
      if (all[all.length - 1] === "") all.pop();
      const m = /^\s*(\d+)\s*(?:-\s*(\d+)?)?\s*$/.exec(opts.lines);
      if (!m) throw new UserError("bad_lines", 'lines is a range like "10-40", "10-" or "10".');
      const start = Math.max(1, Number(m[1]));
      if (start > all.length) {
        throw new UserError("bad_lines", `lines ${opts.lines.trim()} is past the end: ${path} has ${all.length} lines.`);
      }
      if (m[2] && Number(m[2]) < start) {
        throw new UserError("bad_lines", `lines ${opts.lines.trim()} is reversed; give the first line first, like "10-40".`);
      }
      const end = Math.min(all.length, m[2] ? Number(m[2]) : opts.lines.includes("-") ? all.length : start);
      result.content = all.slice(start - 1, end).join("\n");
      result.lines = { start, end, total: all.length };
    }
    return result;
  }

  async search(caller: Caller, query: string, path?: string, limit = 10) {
    if (!query?.trim()) throw new UserError("bad_query", "query is empty.");
    if (query.length > MAX_QUERY) {
      throw new UserError("bad_query", `query is ${query.length} characters; the cap is ${MAX_QUERY}. Search with the words that matter.`);
    }
    const dir = dirPath(path);
    if (!canSeeDir(caller, dir)) throw new UserError("forbidden", `This key may not read ${dir}.`, 403);
    let scope = readScope(caller);
    if (dir) scope = scope === null ? [dir] : narrow(scope, dir);
    return hybridSearch(this.store, this.embeddings, query, scope, Math.min(Math.max(limit, 1), 50));
  }

  async history(caller: Caller, path: string, limit = 20) {
    path = filePath(path);
    requireRead(caller, path);
    const versions = await this.git.history(path, Math.min(Math.max(limit, 1), 1000));
    if (!versions.length && !this.files.exists(path)) throw new UserError("not_found", `${path} does not exist and has no history.`, 404);
    return { versions };
  }

  /** The latest changes to the notes under a folder, newest first: what changed since an agent last looked. */
  async changes(caller: Caller, path: string | undefined, limit = 20): Promise<{ path: string; changes: Change[] }> {
    const dir = dirPath(path);
    if (!canSeeDir(caller, dir)) throw new UserError("forbidden", `This key may not read ${dir}.`, 403);
    limit = Math.min(Math.max(limit, 1), 1000);
    const changes = (await this.git.changes(dir, limit)).filter((c) => isNotePath(c.path) && canRead(caller, c.path));
    return { path: dir, changes: changes.slice(0, limit) };
  }

  async diff(caller: Caller, path: string, from: string | undefined, to: string) {
    path = filePath(path);
    requireRead(caller, path);
    return { diff: await this.git.diff(path, from, to) };
  }

  // Writing

  async write(caller: Caller, path: string, content: string, why: string, baseVersion?: string) {
    path = filePath(path);
    requireWrite(caller, path);
    checkWhy(why);
    if (typeof content !== "string") throw new UserError("bad_content", "content must be text.");
    if (baseVersion !== undefined && baseVersion.trim().length < 7) {
      throw new UserError("bad_version", `baseVersion "${baseVersion}" is too short; pass the version that read returned.`);
    }
    this.files.checkSize(path, content);
    return this.locks.run(path, async () => {
      const current = await this.files.read(path);
      if (current !== null) {
        const version = versionOf(current);
        if (!baseVersion) {
          // Not the whole note: the caller may not need it, and it can be long. Its outline says what to read.
          throw new UserError(
            "exists",
            `${path} already exists. Change it with edit, or read the lines you need and write again with baseVersion ${version.slice(0, 12)}.`,
            409,
            { version, outline: outline(current) },
          );
        }
        if (!sameVersion(baseVersion, version)) {
          throw new UserError(
            "stale",
            `${path} has changed since version ${baseVersion}. Its current text is below; merge your change into it and write again with baseVersion ${version.slice(0, 12)}.`,
            409,
            { version, content: current },
          );
        }
      } else if (baseVersion) {
        throw new UserError("stale", `${path} no longer exists (it was deleted after version ${baseVersion}).`, 409, {
          version: null,
          content: null,
        });
      }
      return this.commitChange(caller, path, current, content, why);
    });
  }

  async edit(caller: Caller, path: string, oldText: string, newText: string, why: string) {
    path = filePath(path);
    requireWrite(caller, path);
    checkWhy(why);
    if (typeof oldText !== "string" || typeof newText !== "string") {
      throw new UserError("bad_content", "old and new must be text.");
    }
    return this.locks.run(path, async () => {
      const current = await this.files.read(path);
      let next: string;
      if (oldText === "") {
        if (current === null) {
          throw new UserError("not_found", `${path} does not exist. Create it with write, starting with a "# Title" and a one-line summary.`, 404);
        }
        next = current + (current === "" || current.endsWith("\n") ? "" : "\n") + newText;
      } else {
        if (current === null) throw new UserError("not_found", `${path} does not exist.`, 404);
        const count = current.split(oldText).length - 1;
        if (count === 0) {
          throw new UserError("no_match", `The old text was not found in ${path}. Read the file and copy the text exactly.`, 409);
        }
        if (count > 1) {
          throw new UserError("ambiguous", `The old text appears ${count} times in ${path}; include more of the surrounding text so it matches once.`, 409);
        }
        next = current.replace(oldText, () => newText);
      }
      this.files.checkSize(path, next);
      return this.commitChange(caller, path, current, next, why);
    });
  }

  async delete(caller: Caller, path: string, why: string) {
    path = filePath(path);
    requireWrite(caller, path);
    checkWhy(why);
    return this.locks.run(path, async () => {
      const current = await this.files.read(path);
      if (current === null) throw new UserError("not_found", `${path} does not exist.`, 404);
      return this.commitChange(caller, path, current, null, why);
    });
  }

  /** Writes the old content of a file from its history as a new commit. */
  async restore(caller: Caller, path: string, ref: string) {
    path = filePath(path);
    requireWrite(caller, path);
    const { content } = await this.git.readVersion(path, ref);
    return this.locks.run(path, async () => {
      const current = await this.files.read(path);
      return this.commitChange(caller, path, current, content, `Restore ${path} to ${ref.slice(0, 12)}`);
    });
  }

  /** Writes (or removes, when next is null) a file, commits it and indexes it. Call with the path's lock held. */
  private async commitChange(caller: Caller, path: string, current: string | null, next: string | null, why: string) {
    if (next === current) return { path, version: next === null ? null : versionOf(next), commit: null as string | null };
    let commit: string | null;
    try {
      if (next === null) this.files.remove(path);
      else await this.files.write(path, next);
      commit = await this.git.commit([path], caller.name, why);
    } catch (err) {
      // Put the file back so disk and history stay in step.
      try {
        if (current === null) this.files.remove(path);
        else await this.files.write(path, current);
      } catch (undo) {
        console.error(`could not put ${path} back:`, undo);
      }
      throw err;
    }
    try {
      await this.indexFile(path, next);
    } catch (err) {
      // The change is committed, so it is not an error for the caller. The
      // watcher (or the next start) re-indexes the file by its hash.
      console.error(`could not index ${path}:`, err);
    }
    return { path, version: next === null ? null : versionOf(next), commit };
  }

  // Indexing

  /** Indexes a file; `updatedAt` is when it last changed, now unless given. */
  private async indexFile(path: string, content: string | null, hash = content === null ? "" : versionOf(content), updatedAt?: string) {
    if (content === null) {
      await this.store.deleteDoc(path);
      this.embeddings.dropDoc(path);
      return;
    }
    const { title, summary, sections } = parseMarkdown(content);
    const doc = {
      path,
      title,
      summary,
      hash,
      bytes: byteLength(content),
      updatedAt: updatedAt ?? new Date().toISOString(),
    };
    const { ids } = await this.store.putDoc(doc, sections);
    this.embeddings.setDoc(path, ids.map((id, i) => ({ id, textHash: sections[i].textHash })));
  }

  /**
   * At start, before any request: brings the index in line with the files, by
   * content hash, and commits outside changes in one commit. One bad file
   * never stops the start.
   */
  private async reconcileAll() {
    const paths = new Set([...this.files.allFiles(), ...(await this.store.docHashes()).keys()]);
    // What gets indexed now (after a reindex, a lost database, a new machine) keeps the time it last
    // changed: its last commit, unless it has changed since. Read once, and only if needed.
    let dates: Promise<Map<string, string>> | null = null;
    const changedAt = (path: string) =>
      (dates ??= Promise.all([this.git.lastChanges(), this.git.changed()]).then(([last, dirty]) => {
        for (const p of dirty) last.delete(p);
        return last;
      })).then((d) => d.get(path));
    for (const path of paths) await this.syncPath(path, changedAt).catch((err) => console.error(`could not index ${path}:`, err));
    if (await this.git.dirty()) await this.git.commit([], OUTSIDE, `Changes made outside ${NAME}`);
  }

  /** The same for one folder while running: each outside change is committed under its file's lock. */
  private async reconcileDir(dir: string) {
    const paths = new Set([...this.files.allFiles(dir), ...(await this.store.docsUnder(dir)).map((d) => d.path)]);
    for (const path of paths) await this.syncPath(path).catch((err) => console.error(`could not index ${path}:`, err));
    for (const path of await this.git.changed(dir)) {
      if (isNotePath(path)) await this.commitOutside(path);
    }
  }

  private async reconcilePath(path: string) {
    await this.syncPath(path);
    await this.commitOutside(path);
  }

  /**
   * Commits a change made outside. Under the file's lock, so a write of the
   * server's own that waits for git is never taken in and authored "outside".
   */
  private async commitOutside(path: string) {
    await this.locks.run(path, async () => {
      if (await this.git.dirty(path)) await this.git.commit([path], OUTSIDE, `Change to ${path} made outside ${NAME}`);
    });
  }

  /**
   * Re-indexes one file if it differs from the index. The comparison is made
   * under the file's lock with the index as it is then, so a file the server
   * has just written itself is left alone. A file that is not UTF-8 is indexed
   * as empty.
   */
  private async syncPath(path: string, changedAt?: (path: string) => Promise<string | undefined>) {
    await this.locks.run(path, async () => {
      let content: string | null;
      let hash: string | undefined;
      try {
        content = await this.files.read(path);
      } catch (err) {
        if (!(err instanceof UserError && err.code === "not_text")) throw err;
        content = "";
        hash = err.details!.version as string;
      }
      hash ??= content === null ? undefined : versionOf(content);
      const known = await this.store.getDoc(path);
      if (hash === undefined ? known !== null : known?.hash !== hash) {
        await this.indexFile(path, content, hash, content === null ? undefined : await changedAt?.(path));
      }
    });
  }

  private startWatching() {
    try {
      this.watcher = watch(this.files.root, { recursive: true }, (_event, name) => {
        const rel = String(name ?? "").split("\\").join("/").replace(/\/+$/, "");
        // .git, the temporary files of a write, and other hidden names.
        if (!rel || rel.split("/").some((s) => s.startsWith("."))) return;
        let key: string;
        try {
          key = rel.endsWith(".md") ? filePath(rel) : dirPath(rel);
        } catch {
          return; // not a valid note or folder path
        }
        // A folder change (create, rename, removal) reconciles that folder only.
        this.debounce(key, () => (key.endsWith(".md") ? this.reconcilePath(key) : this.reconcileDir(key)));
      });
    } catch (err) {
      console.error("file watcher unavailable; outside changes are picked up on restart:", err);
    }
  }

  private debounce(key: string, fn: () => Promise<void>) {
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        fn().catch((err) => console.error("reconcile failed:", err));
      }, 200),
    );
  }
}

/** A note's title, summary and headings with their line ranges: enough to choose what to read. */
function outline(content: string): string {
  const { title, summary, sections } = parseMarkdown(content);
  const lines = content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
  const head = [`# ${title || "(no title)"}`, summary, `${lines} lines:`].filter(Boolean);
  return [...head, ...sections.map((s) => `${s.startLine}-${s.endLine} ${s.heading}`.trimEnd())].join("\n");
}

function checkWhy(why: unknown) {
  if (typeof why !== "string" || !oneLine(why)) {
    throw new UserError("bad_why", "why is required: one line saying why this change is made.");
  }
}

function isNotePath(path: string): boolean {
  try {
    return filePath(path) === path;
  } catch {
    return false;
  }
}

function sameVersion(given: string, actual: string): boolean {
  const g = given.trim().toLowerCase();
  return g.length >= 7 && actual.startsWith(g);
}

/** Intersects a key's readable prefixes with a folder. */
function narrow(scope: string[], dir: string): string[] {
  const out: string[] = [];
  for (const p of scope) {
    if (dir.startsWith(p)) out.push(dir);
    else if (p.startsWith(dir)) out.push(p);
  }
  return [...new Set(out)];
}
