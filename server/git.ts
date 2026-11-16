// The data folder's own git repository: one commit per write, authored by the agent.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { NAME } from "./name";
import { Locks, UserError } from "./files";

export interface Version {
  version: string | null; // blob id of the file at this commit; null when the commit deleted it
  commit: string;
  at: string;
  agent: string;
  why: string;
}

/** One file's change in a folder's history. */
export interface Change extends Version {
  path: string;
}

const LOG_FORMAT = "--format=%x1e%H%x1f%aI%x1f%an%x1f%s";

/** A version or commit id, or a prefix of one: 40 characters, or 64 in a SHA-256 repository. */
const HEX = /^[0-9a-f]{7,64}$/;
/** Git's id for an empty tree, which every repository knows. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Kept in .git/info/exclude, so a whole-tree commit takes in notes only, not stray files. */
const EXCLUDE = `# ${NAME}: only notes are kept in history
*
!*/
!*.md
.*
`;

export class Git {
  private locks = new Locks();
  /** Characters in a whole commit id: 40, or 64 in a SHA-256 repository. Read by init. */
  private idLength = 40;

  constructor(private root: string) {}

  private async run(args: string[], opts: { env?: Record<string, string>; ok?: number[] } = {}) {
    // --no-optional-locks: status and diff must not take index.lock behind the git lock's back.
    const proc = Bun.spawn(["git", "--no-optional-locks", "-c", "commit.gpgsign=false", "-c", "core.quotepath=off", ...args], {
      cwd: this.root,
      // LC_ALL=C: commit's "nothing to commit" is read from its output.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...opts.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (!(opts.ok ?? [0]).includes(code)) throw new Error(`git ${args[0]} failed: ${err.trim() || out.trim()}`);
    return { out, err, code };
  }

  /** Creates the repository, or makes an existing one usable after a crash. Call before any other git work. */
  async init() {
    const git = join(this.root, ".git");
    if (existsSync(git)) this.clearStaleLocks(git);
    else await this.run(["init", "-q", "-b", "main"]);
    const exclude = join(git, "info", "exclude");
    mkdirSync(join(git, "info"), { recursive: true });
    if (!existsSync(exclude) || !readFileSync(exclude, "utf8").includes(EXCLUDE)) appendFileSync(exclude, "\n" + EXCLUDE);
    // A repository made with init.defaultObjectFormat=sha256 has 64-character ids.
    const { out } = await this.run(["config", "--get", "extensions.objectFormat"], { ok: [0, 1] });
    this.idLength = out.trim().toLowerCase() === "sha256" ? 64 : 40;
  }

  /**
   * A git process killed mid-commit (a crash, an OOM kill, a power loss) leaves
   * its lock files, and every later commit fails on them. At start no git of
   * ours runs, so any left are stale.
   */
  private clearStaleLocks(git: string) {
    const stale = readdirSync(git).filter((f) => f === "index.lock" || f === "HEAD.lock" || /^next-index-.*\.lock$/.test(f));
    for (const f of stale) rmSync(join(git, f), { force: true });
    const refs = join(git, "refs");
    if (!existsSync(refs)) return;
    for (const f of readdirSync(refs, { recursive: true, encoding: "utf8" })) {
      if (f.endsWith(".lock")) rmSync(join(refs, f), { force: true });
    }
  }

  private authorEnv(agent: string) {
    const email = `${agent.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}@${NAME}.local`;
    return {
      GIT_AUTHOR_NAME: agent,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: NAME,
      GIT_COMMITTER_EMAIL: `${NAME}@${NAME}.local`,
    };
  }

  /** Commits the given paths (or every change when paths is empty). Returns the commit id, or null if nothing changed. */
  async commit(paths: string[], agent: string, why: string): Promise<string | null> {
    return this.locks.run("git", async () => {
      const scope = paths.length ? ["--", ...paths] : [];
      await this.run(["add", "-A", ...scope]);
      // Two processes per write: core.abbrev at the id's length puts the whole commit id in commit's
      // summary line, and commit itself says when there was nothing to commit.
      const { out, err, code } = await this.run(["-c", `core.abbrev=${this.idLength}`, "commit", "--no-verify", "-m", oneLine(why), ...scope], {
        env: this.authorEnv(agent),
        ok: [0, 1],
      });
      if (code === 1 && /^(nothing to commit|no changes added to commit|nothing added to commit)/m.test(out)) return null;
      const id = new RegExp(`\\b([0-9a-f]{${this.idLength}})\\]`).exec(out)?.[1];
      if (code !== 0 || !id) throw new Error(`git commit failed: ${err.trim() || out.trim()}`);
      return id;
    });
  }

  /** True when the working tree has changes git has not committed. */
  async dirty(path?: string): Promise<boolean> {
    return (await this.changed(path)).length > 0;
  }

  /** Paths under `path` (a file or folder; all when empty) whose changes git has not committed. */
  async changed(path?: string): Promise<string[]> {
    return this.locks.run("git", async () => {
      const scope = path ? ["--", path] : [];
      const { out } = await this.run(["status", "--porcelain", "-z", "--no-renames", "--untracked-files=all", ...scope]);
      return out.split("\0").filter(Boolean).map((entry) => entry.slice(3));
    });
  }

  async history(path: string, limit = 20): Promise<Version[]> {
    return (await this.log(path, limit)).filter((c) => c.path === path).map(({ path: _, ...v }) => v);
  }

  /** The latest commits under a folder ("" for all), newest first, with one entry per file each changed. */
  async changes(dir: string, limit = 20): Promise<Change[]> {
    return this.log(dir, limit);
  }

  private async log(path: string, limit: number): Promise<Change[]> {
    const { out } = await this.run(
      ["log", `-n${limit}`, "--no-renames", "--raw", "--no-abbrev", LOG_FORMAT, ...(path ? ["--", path] : [])],
      { ok: [0, 128] }, // 128: no commits yet
    );
    const changes: Change[] = [];
    for (const chunk of out.split("\x1e").slice(1)) {
      const [head, ...rest] = chunk.split("\n");
      const [commit, at, agent, why] = head.split("\x1f");
      // :<old mode> <new mode> <old blob> <new blob> <status>\t<path>
      for (const raw of rest) {
        const tab = raw.indexOf("\t");
        if (!raw.startsWith(":") || tab < 0) continue;
        const blob = raw.slice(0, tab).split(" ")[3];
        changes.push({ path: raw.slice(tab + 1), commit, at, agent, why, version: blob && !/^0+$/.test(blob) ? blob : null });
      }
    }
    return changes;
  }

  /** Each file's last commit time, from one walk of the history. */
  async lastChanges(): Promise<Map<string, string>> {
    const { out } = await this.run(["log", "--no-renames", "--name-only", "--format=%x1e%aI"], { ok: [0, 128] });
    const dates = new Map<string, string>();
    for (const chunk of out.split("\x1e").slice(1)) {
      const [at, ...paths] = chunk.split("\n");
      for (const p of paths) if (p && !dates.has(p)) dates.set(p, new Date(at).toISOString());
    }
    return dates;
  }

  /** Reads an old version of a file, by blob id or commit id from its history. */
  async readVersion(path: string, ref: string): Promise<{ content: string; version: string }> {
    if (!HEX.test(ref)) throw new UserError("bad_version", `"${ref}" is not a version from history.`);
    const all = await this.history(path, 100000);
    const hit = all.find((v) => v.version?.startsWith(ref) || v.commit.startsWith(ref));
    if (!hit) throw new UserError("not_found", `${path} has no version ${ref} in its history.`, 404);
    if (!hit.version) throw new UserError("not_found", `${path} was deleted in commit ${hit.commit.slice(0, 12)}.`, 404);
    const { out } = await this.run(["cat-file", "blob", hit.version]);
    return { content: out, version: hit.version };
  }

  /** Unified diff of one file between two commits; without `from`, against nothing (the file as created). */
  async diff(path: string, from: string | undefined, to: string): Promise<string> {
    for (const ref of from ? [from, to] : [to]) {
      if (!HEX.test(ref)) throw new UserError("bad_version", `"${ref}" is not a commit id.`);
    }
    const { out } = await this.run(["diff", "--no-color", "--no-renames", from ?? EMPTY_TREE, to, "--", path], { ok: [0, 1] });
    return out;
  }
}

export function oneLine(why: string): string {
  return why.replace(/\s+/g, " ").trim();
}
