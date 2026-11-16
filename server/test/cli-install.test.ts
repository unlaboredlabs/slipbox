// install.sh and `update` against a local stand-in for the `edge` release,
// which is replaced in place: for a few seconds an asset can be missing or
// not match checksums.txt.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NAME } from "../name";
import { assetName, downloadRelease } from "../update";

const INSTALL = join(import.meta.dir, "..", "..", "install.sh");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** The release: a fake program, its checksum, and a list of what the next requests answer. */
let binary = "";
let sums = "";
let script: ("404" | "stale")[] = [];
let server: ReturnType<typeof Bun.serve>;
let dir: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const file = new URL(req.url).pathname.slice(1);
      if (file === "checksums.txt") {
        const step = script.shift();
        if (step === "404") return new Response("", { status: 404 });
        if (step === "stale") return new Response(`${sha("an older build")}  ${asset}\n`);
        return new Response(sums);
      }
      if (file === asset) return new Response(binary);
      return new Response("", { status: 404 });
    },
  });
});
afterAll(() => server.stop(true));
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), `${NAME}-install-test-`));
  binary = `#!/bin/sh\necho "${NAME} 99 (test)"\n`;
  sums = `${sha("other")}  ${NAME}-linux-arm64\n${sha(binary)}  ${asset}\n`;
  script = [];
});

const os = process.platform === "darwin" ? "darwin" : "linux";
const arch = process.arch === "arm64" ? "arm64" : "x64";
const asset = `${NAME}-${os}-${arch}`;

describe("install.sh", () => {
  test("retries while a new release is being published, then installs", async () => {
    script = ["404", "stale"];
    const bin = join(dir, "bin");
    const proc = Bun.spawn(["sh", INSTALL], {
      env: { PATH: process.env.PATH!, HOME: dir, SHELL: "/bin/zsh", SLIPBOX_RELEASE_URL: server.url.href.replace(/\/$/, ""), SLIPBOX_BIN_DIR: bin, SLIPBOX_RETRY_SECONDS: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    expect(await proc.exited).toBe(0);
    expect(out.match(/A new release is being published/g)?.length).toBe(2);
    expect(out).toContain(`Installed ${NAME} 99 (test) to ${bin}/${NAME}`);
    // Not on PATH: the hint names the zsh login profile and the full path that works meanwhile.
    expect(out).toContain(">> ~/.zprofile");
    expect(out).toContain(`Meanwhile, run it as ${bin}/${NAME}.`);
    expect(readdirSync(bin)).toEqual([NAME]); // the download folder beside it is gone
    rmSync(dir, { recursive: true, force: true });
  });

  for (const shell of ["sh", "dash", "busybox sh"]) {
    test(`fails calmly after the retries under ${shell}, installing nothing`, async () => {
      const [cmd, ...pre] = shell.split(" ");
      if (!Bun.which(cmd)) return;
      script = ["stale", "stale", "stale", "stale"];
      const bin = join(dir, "bin");
      const proc = Bun.spawn([cmd, ...pre, INSTALL], {
        env: { PATH: process.env.PATH!, HOME: dir, SLIPBOX_RELEASE_URL: server.url.href.replace(/\/$/, ""), SLIPBOX_BIN_DIR: bin, SLIPBOX_RETRY_SECONDS: "0" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
      expect(await proc.exited).toBe(1);
      expect(out).toContain("A new release may still be being published; try again in a minute.");
      expect(existsSync(join(bin, NAME))).toBe(false);
      expect(readdirSync(bin)).toEqual([]);
      rmSync(dir, { recursive: true, force: true });
    });
  }
});

describe("update's download", () => {
  test("retries a missing asset or a checksum mismatch, then succeeds", async () => {
    script = ["404", "stale"];
    const file = join(dir, "download");
    await downloadRelease(server.url.href.replace(/\/$/, ""), asset, file, { waitMs: 0 });
    expect(readFileSync(file, "utf8")).toBe(binary);
    expect(script).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("gives up after the retries with a calm message", async () => {
    script = ["stale", "stale", "stale", "stale"];
    const file = join(dir, "download");
    await expect(downloadRelease(server.url.href.replace(/\/$/, ""), asset, file, { waitMs: 0 })).rejects.toThrow(
      "A new release may still be being published; try again in a minute.",
    );
    rmSync(dir, { recursive: true, force: true });
  });

  test("names the asset for this machine", () => {
    expect(assetName()).toBe(`${NAME}-${process.platform}-${process.arch}`);
  });
});
