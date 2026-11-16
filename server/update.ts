// `update`: the same download as install.sh, from the rolling `edge` release.
import { createHash } from "node:crypto";
import { chmodSync, closeSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { type Config, ENV_PREFIX } from "./config";
import { NAME, REPO } from "./name";
import { selfCommand, service, serviceInstalled } from "./service";
import { VERSION } from "./version";

export const releaseUrl = () => process.env[`${ENV_PREFIX}RELEASE_URL`] || `https://github.com/${REPO}/releases/download/edge`;

export function assetName(): string {
  const os = process.platform === "darwin" ? "darwin" : process.platform;
  return `${NAME}-${os}-${process.arch}`;
}

/** No byte for this long means the download is stuck. */
const STALL_MS = 30_000;

class Retryable extends Error {}

async function get(url: string, signal?: AbortSignal): Promise<Response> {
  const res = await fetch(url, { redirect: "follow", signal: signal ?? AbortSignal.timeout(STALL_MS) });
  if (res.status === 404) throw new Retryable(`${url} answered 404`);
  if (!res.ok) throw new Error(`download failed: ${url} answered ${res.status}`);
  return res;
}

/** Streams `url` into `file`, hashing as it goes; shows progress on a terminal. Returns the sha256. */
async function downloadTo(url: string, file: string): Promise<string> {
  const abort = new AbortController();
  let timer = setTimeout(() => abort.abort(), STALL_MS);
  const hash = createHash("sha256");
  const fd = openSync(file, "w", 0o600);
  try {
    const res = await get(url, abort.signal);
    const total = Number(res.headers.get("content-length")) || 0;
    let done = 0;
    let shown = -1;
    for await (const chunk of res.body!) {
      clearTimeout(timer);
      timer = setTimeout(() => abort.abort(), STALL_MS);
      hash.update(chunk);
      writeSync(fd, chunk);
      done += chunk.length;
      const pct = total ? Math.floor((done / total) * 100) : -1;
      if (process.stdout.isTTY && pct !== shown) {
        shown = pct;
        process.stdout.write(`\r  ${pct}% of ${Math.round(total / 1e6)} MB`);
      }
    }
    if (process.stdout.isTTY && shown >= 0) process.stdout.write("\n");
    return hash.digest("hex");
  } catch (err) {
    if (abort.signal.aborted) throw new Error(`download stalled: no data from ${url} for ${STALL_MS / 1000} s`);
    throw err;
  } finally {
    clearTimeout(timer);
    closeSync(fd);
  }
}

/**
 * Downloads the asset and checksums.txt together into `file` and checks them.
 * `edge` is replaced in place on every release, so for a few seconds an asset
 * can be missing or not match the checksums: that is retried, then reported.
 */
export async function downloadRelease(base: string, asset: string, file: string, opts: { tries?: number; waitMs?: number } = {}) {
  const tries = opts.tries ?? 4;
  for (let attempt = 1; ; attempt++) {
    try {
      const actual = await downloadTo(`${base}/${asset}`, file);
      const sums = await (await get(`${base}/checksums.txt`)).text();
      const expected = sums
        .split("\n")
        .map((l) => l.trim().split(/\s+\*?/))
        .find(([, f]) => f === asset)?.[0];
      if (!expected) throw new Retryable(`checksums.txt has no entry for ${asset}`);
      if (expected !== actual) throw new Retryable(`checksum mismatch for ${asset}: expected ${expected}, got ${actual}`);
      return;
    } catch (err) {
      if (!(err instanceof Retryable)) throw err;
      if (attempt >= tries) {
        throw new Error(`${err.message}.\nA new release may still be being published; try again in a minute.`);
      }
      const wait = opts.waitMs ?? 10_000;
      console.log(`A new release is being published; trying again in ${Math.round(wait / 1000)} s.`);
      await Bun.sleep(wait);
    }
  }
}

export async function update(config: Config) {
  const self = selfCommand();
  if (self.length > 1) throw new Error(`This copy runs from source; update it with git pull. "${NAME} update" updates the installed program.`);
  const base = releaseUrl();
  const latest = (await (await get(`${base}/version`)).text()).trim();
  if (latest === VERSION) return console.log(`Already on ${latest}.`);

  // Download next to the program, then swap it in with a rename (atomic on the same filesystem).
  const target = self[0];
  const tmp = `${target}.download`;
  try {
    console.log(`Downloading ${NAME} ${latest} ...`);
    await downloadRelease(base, assetName(), tmp);
    chmodSync(tmp, 0o755);
    renameSync(tmp, target);
  } finally {
    rmSync(tmp, { force: true });
  }
  console.log(`${VERSION} → ${latest}`);
  if (serviceInstalled(config)) {
    await service(config).restart();
    console.log("Service restarted.");
  }
}
