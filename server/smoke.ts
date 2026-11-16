// Smoke test of a compiled program, as CI runs it:
//   bun server/smoke.ts dist/<name>
// Starts it with a fresh config and data folder, checks /api/health and the
// dashboard, creates a key and runs the MCP end-to-end check (server/e2e.ts).
// Meaning search must work unless the build has no embedding runtime.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NAME } from "./name";

const bin = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("usage: bun server/smoke.ts <compiled program>");
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), `${NAME}-smoke-`));
const port = 20000 + Math.floor(Math.random() * 20000);
const token = "smoke-admin-token";
const env = { ...process.env, SLIPBOX_CONFIG_FILE: join(dir, "config.env") };
writeFileSync(env.SLIPBOX_CONFIG_FILE, `ADMIN_TOKEN=${token}\nDATA_DIR=${join(dir, "data")}\nPORT=${port}\n`);
const url = `http://127.0.0.1:${port}`;

async function cli(...args: string[]): Promise<string> {
  const proc = Bun.spawn([bin, ...args], { env, stdout: "pipe", stderr: "inherit" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`${args.join(" ")} failed:\n${out}`);
  return out;
}

async function health(): Promise<any> {
  try {
    const res = await fetch(`${url}/api/health`, { headers: { Authorization: `Bearer ${token}` } });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

const server = Bun.spawn([bin, "serve"], { env, stdout: "inherit", stderr: "inherit" });
try {
  console.log(await cli("version"));
  const key = /Key \(shown once\): (\S+)/.exec(await cli("key", "create", "smoke", "--write", "/"))?.[1];
  if (!key) throw new Error("key create printed no key");

  let h: any = null;
  for (let i = 0; i < 300 && !(h?.embed?.loaded || h?.embed?.lastError); i++) {
    await Bun.sleep(500); // the first start downloads the model
    h = await health();
  }
  console.log("health:", JSON.stringify(h));
  if (!h?.ok) throw new Error("the server did not become healthy");
  const noRuntime = /no embedding runtime/.test(h.embed.lastError ?? "");
  if (!h.embed.loaded && !noRuntime) throw new Error(`the embedding model did not load: ${h.embed.lastError}`);

  const page = await fetch(url + "/", { headers: { Accept: "text/html" } });
  if (page.status !== 200) throw new Error(`/ answered ${page.status}`);

  const e2e = Bun.spawn(
    ["bun", resolve(import.meta.dir, "e2e.ts"), url, key, ...(noRuntime ? ["--words-only"] : [])],
    { stdout: "inherit", stderr: "inherit" },
  );
  if ((await e2e.exited) !== 0) throw new Error("the end-to-end check failed");
  console.log(noRuntime ? "smoke test passed (words only: no embedding runtime in this build)" : "smoke test passed");
} finally {
  server.kill();
  await server.exited;
  rmSync(dir, { recursive: true, force: true });
}
