// The memory: files on disk as the truth, git as history, the database as the index.
// The MCP tools and the dashboard API are thin layers over this class.
import { watch, type FSWatcher } from "node:fs";
import { type Caller, canRead, canSeeDir, readScope, requireRead, requireWrite } from "./access";
import type { Store } from "./db";
import { EventLog } from "./events";
import { Files, Locks, UserError, byteLength, dirPath, filePath, versionOf } from "./files";
import { Git, oneLine } from "./git";
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

export class Memory {
  readonly files: Files;
  readonly git: Git;
  readonly embeddings: Embeddings;
  readonly events: EventLog;
  private locks = new Locks();
  private watcher: FSWatcher | null = null;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  private constructor(
    readonly store: Store,
    private opts: MemoryOptions,
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
    if (opts.watch) m.startWatching();
    return m;
  }

  async close() {
    this.watcher?.close();
    for (const t of this.timers.values()) clearTimeout(t);
    this.embeddings.close();
    // Let a batch in flight finish, but never wait long on the model.
    await Promise.race([this.embeddings.settle(), Bun.sleep(2000)]);
  }

  // Reading

  async start(caller: Caller, path?: string) {
    const target = path?.endsWith(".md") ? filePath(path) : dirPath(path);
    const dir = target.endsWith(".md") ? target.slice(0, target.lastIndexOf("/") + 1) : target;
    const profiles: { path: string; content: string }[] = [];
    const parts = dir.split("/").filter(Boolean);
    for (let i = 0; i <= parts.length; i++) {
      const p = parts.slice(0, i).map((s) => s + "/").join("") + "profile.md";
      if (!canRead(caller, p)) continue;
      const content = await this.files.read(p);
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
      const end = Math.min(all.length, m[2] ? Number(m[2]) : opts.lines.includes("-") ? all.length : start);
      result.content = all.slice(start - 1, end).join("\n");
      result.lines = { start, end, total: all.length };
    }
    return result;
  }

  async search(caller: Caller, query: string, path?: string, limit = 10) {
    if (!query?.trim()) throw new UserError("bad_query", "query is empty.");
    const dir = dirPath(path);
    let scope = readScope(caller);
    if (dir) scope = scope === null ? [dir] : narrow(scope, dir);
    return hybridSearch(this.store, this.embeddings, query, scope, Math.min(Math.max(limit, 1), 50));
  }

  async history(caller: Caller, path: string, limit = 20) {
    path = filePath(path);
    requireRead(caller, path);
    return { versions: await this.git.history(path, Math.min(Math.max(limit, 1), 1000)) };
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
    this.files.checkSize(path, content);
    return this.locks.run(path, async () => {
      const current = await this.files.read(path);
      if (current !== null) {
        const version = versionOf(current);
        if (!baseVersion || !sameVersion(baseVersion, version)) {
          throw new UserError(
            "stale",
            baseVersion
              ? `${path} has changed since version ${baseVersion}. Here is the current text; merge your change into it and write again with baseVersion ${version}.`
              : `${path} already exists. Read it, merge your change, and write again with baseVersion ${version} (or use edit).`,
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
        const base = current ?? "";
        next = base + (base === "" || base.endsWith("\n") ? "" : "\n") + newText;
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
    if (next === null) this.files.remove(path);
    else await this.files.write(path, next);
    let commit: string | null;
    try {
      commit = await this.git.commit([path], caller.name, why);
    } catch (err) {
      // Put the file back so disk and history stay in step.
      if (current === null) this.files.remove(path);
      else await this.files.write(path, current);
      throw err;
    }
    await this.indexFile(path, next);
    return { path, version: next === null ? null : versionOf(next), commit };
  }

  // Indexing

  private async indexFile(path: string, content: string | null) {
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
      hash: versionOf(content),
      bytes: byteLength(content),
      updatedAt: new Date().toISOString(),
    };
    const { ids } = await this.store.putDoc(doc, sections);
    this.embeddings.setDoc(path, ids.map((id, i) => ({ id, textHash: sections[i].textHash })));
  }

  /** Brings the index in line with the files, by content hash, and commits outside changes. */
  async reconcileAll() {
    const paths = new Set([...this.files.allFiles(), ...(await this.store.docHashes()).keys()]);
    for (const path of paths) await this.syncPath(path);
    if (await this.git.dirty()) await this.git.commit([], OUTSIDE, `Changes made outside ${NAME}`);
  }

  private async reconcilePath(path: string) {
    await this.syncPath(path);
    await this.locks.run(path, async () => {
      if (await this.git.dirty(path)) await this.git.commit([path], OUTSIDE, `Change to ${path} made outside ${NAME}`);
    });
  }

  /**
   * Re-indexes one file if it differs from the index. The comparison is made
   * under the file's lock with the index as it is then, so a file the server
   * has just written itself is left alone.
   */
  private async syncPath(path: string) {
    await this.locks.run(path, async () => {
      const content = await this.files.read(path);
      const known = await this.store.getDoc(path);
      if (content === null ? known !== null : known?.hash !== versionOf(content)) await this.indexFile(path, content);
    });
  }

  private startWatching() {
    try {
      this.watcher = watch(this.files.root, { recursive: true }, (_event, name) => {
        const rel = String(name ?? "").split("\\").join("/");
        if (!rel || rel === ".git" || rel.startsWith(".git/")) return;
        let path: string | null = null;
        try {
          path = rel.endsWith(".md") ? filePath(rel) : null;
        } catch {
          return; // not a valid note path
        }
        // A folder change (rename, removal) is handled by a full reconcile.
        this.debounce(path ?? "*", () => (path ? this.reconcilePath(path) : this.reconcileAll()));
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

function checkWhy(why: unknown) {
  if (typeof why !== "string" || !oneLine(why)) {
    throw new UserError("bad_why", "why is required: one line saying why this change is made.");
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
