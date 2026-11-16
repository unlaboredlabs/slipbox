// The data folder's own git repository: one commit per write, authored by the agent.
import { existsSync } from "node:fs";
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

const HEX = /^[0-9a-f]{7,40}$/;
/** Git's id for an empty tree, which every repository knows. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export class Git {
  private locks = new Locks();

  constructor(private root: string) {}

  private async run(args: string[], opts: { env?: Record<string, string>; ok?: number[] } = {}) {
    const proc = Bun.spawn(["git", "-c", "commit.gpgsign=false", "-c", "core.quotepath=off", ...args], {
      cwd: this.root,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (!(opts.ok ?? [0]).includes(code)) throw new Error(`git ${args[0]} failed: ${err.trim() || out.trim()}`);
    return { out, code };
  }

  async init() {
    if (existsSync(join(this.root, ".git"))) return;
    await this.run(["init", "-q", "-b", "main"]);
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
      const { code } = await this.run(["diff", "--cached", "--quiet", ...scope], { ok: [0, 1] });
      if (code === 0) return null;
      await this.run(["commit", "-q", "--no-verify", "-m", oneLine(why), ...scope], { env: this.authorEnv(agent) });
      const { out } = await this.run(["rev-parse", "HEAD"]);
      return out.trim();
    });
  }

  /** True when the working tree has changes git has not committed. */
  async dirty(path?: string): Promise<boolean> {
    const { out } = await this.run(["status", "--porcelain", "--untracked-files=all", ...(path ? ["--", path] : [])]);
    return out.trim() !== "";
  }

  async history(path: string, limit = 20): Promise<Version[]> {
    const { out } = await this.run(
      ["log", `-n${limit}`, "--no-renames", "--raw", "--no-abbrev", "--format=%x1e%H%x1f%aI%x1f%an%x1f%s", "--", path],
      { ok: [0, 128] }, // 128: no commits yet
    );
    const versions: Version[] = [];
    for (const chunk of out.split("\x1e").slice(1)) {
      const [head, ...rest] = chunk.split("\n");
      const [commit, at, agent, why] = head.split("\x1f");
      const raw = rest.find((l) => l.startsWith(":") && l.endsWith("\t" + path));
      const blob = raw?.split(" ")[3] ?? null;
      versions.push({ commit, at, agent, why, version: blob && !/^0+$/.test(blob) ? blob : null });
    }
    return versions;
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
