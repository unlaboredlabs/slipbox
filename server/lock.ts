// One process at a time on a data folder: the server and `reindex` hold a lock
// file beside it (never inside, where the watcher and git would see it). The
// file holds the owner's pid, so a lock left by a killed process is taken over.
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { UserError } from "./files";
import { NAME } from "./name";

const held = new Set<string>();

export const lockFile = (dataDir: string) => `${dataDir}.lock`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM"; // alive, but another user's
  }
}

/** Takes the data folder's lock, or throws if a live process holds it. Returns the release function. */
export function lockDataDir(dataDir: string): () => void {
  const file = lockFile(dataDir);
  if (held.has(file)) throw new UserError("locked", `${dataDir} is already in use by this process.`);
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      break;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      let pid = NaN;
      try {
        pid = Number.parseInt(readFileSync(file, "utf8"), 10);
      } catch {}
      // Our own pid in the file is a leftover too: a restarted container often gets the same pid.
      if (attempt === 0 && !(pid > 0 && pid !== process.pid && alive(pid))) {
        rmSync(file, { force: true });
        continue;
      }
      throw new UserError(
        "locked",
        `${NAME} is already running on ${dataDir} (pid ${pid || "unknown"}). Stop it first (${NAME} service stop).\n` +
          `If no ${NAME} runs, remove ${file}.`,
      );
    }
  }
  held.add(file);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.off("exit", release);
    held.delete(file);
    try {
      if (Number.parseInt(readFileSync(file, "utf8"), 10) === process.pid) rmSync(file, { force: true });
    } catch {}
  };
  process.once("exit", release);
  return release;
}
