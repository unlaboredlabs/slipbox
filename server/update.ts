// `update`: the same download as install.sh, from the rolling `edge` release.
import { createHash } from "node:crypto";
import { chmodSync, renameSync, rmSync } from "node:fs";
import type { Config } from "./config";
import { NAME, REPO } from "./name";
import { selfCommand, service, serviceInstalled } from "./service";
import { VERSION } from "./version";

export const releaseUrl = () => process.env.RELEASE_URL || `https://github.com/${REPO}/releases/download/edge`;

export function assetName(): string {
  const os = process.platform === "darwin" ? "darwin" : process.platform;
  return `${NAME}-${os}-${process.arch}`;
}

async function get(url: string): Promise<Response> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download failed: ${url} answered ${res.status}`);
  return res;
}

export async function update(config: Config) {
  const self = selfCommand();
  if (self.length > 1) throw new Error(`This copy runs from source; update it with git pull. "${NAME} update" updates the installed program.`);
  const base = releaseUrl();
  const latest = (await (await get(`${base}/version`)).text()).trim();
  if (latest === VERSION) return console.log(`Already on ${latest}.`);

  const asset = assetName();
  const [binary, sums] = await Promise.all([
    get(`${base}/${asset}`).then((r) => r.arrayBuffer()),
    get(`${base}/checksums.txt`).then((r) => r.text()),
  ]);
  const expected = sums
    .split("\n")
    .map((l) => l.trim().split(/\s+\*?/))
    .find(([, file]) => file === asset)?.[0];
  const actual = createHash("sha256").update(new Uint8Array(binary)).digest("hex");
  if (!expected) throw new Error(`checksums.txt has no entry for ${asset}`);
  if (expected !== actual) throw new Error(`checksum mismatch for ${asset}: expected ${expected}, got ${actual}`);

  // Write next to the program, then swap it in with a rename (atomic on the same filesystem).
  const target = self[0];
  const tmp = `${target}.download`;
  try {
    await Bun.write(tmp, binary);
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
