// End-to-end check against a running server with the official MCP client:
//   bun server/e2e.ts <url> <agent key> [--words-only]
// Writes a note under agents/e2e/, finds it by a word and by a paraphrase,
// edits it, reads its history and an old version, then deletes it.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [url, key] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const wordsOnly = process.argv.includes("--words-only");
if (!url || !key) {
  console.error("usage: bun server/e2e.ts <url> <agent key> [--words-only]");
  process.exit(2);
}

const client = new Client({ name: "e2e", version: "1" });
await client.connect(
  new StreamableHTTPClientTransport(new URL("/mcp", url), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }),
);

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const r: any = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  if (r.isError) throw new Error(`${name} failed: ${text}`);
  return text;
}

/** Fails with `what`, and with what the server answered, so a failure on CI explains itself. */
function check(ok: unknown, what: string, got?: unknown) {
  if (!ok) throw new Error(`FAILED: ${what}${got === undefined ? "" : `\ngot: ${JSON.stringify(got, null, 2)}`}`);
  console.log(`ok  ${what}`);
}

const path = `agents/e2e/check-${Date.now()}.md`;
const note = "# Release train\n\nWe ship to production every Tuesday morning, once the staging smoke tests are green.\n";

check((await call("start", {})).includes("# Profiles"), "start returns profiles and the map");
const written = JSON.parse(await call("write", { path, content: note, why: "e2e: create a note" }));
check(/^[0-9a-f]{40}$/.test(written.commit), `write ${path} is a commit`);

const words = JSON.parse(await call("search", { query: "tuesday smoke tests", path: "agents/e2e" }));
check(words.results[0]?.path === path && words.results[0].wordRank === 1, "search by a word finds it", words);

if (!wordsOnly) {
  // The embedding is queued after the write; give it a moment to land.
  let hit: any;
  for (let i = 0; i < 100 && !hit?.meaningRank; i++) {
    const r = JSON.parse(await call("search", { query: "when do we deploy new versions to customers?", path: "agents/e2e" }));
    hit = r.results.find((x: any) => x.path === path);
    if (!hit?.meaningRank) await Bun.sleep(300);
  }
  check(hit?.meaningRank === 1 && hit.wordRank === null, "search by a paraphrase finds it by meaning alone", hit);
}

await call("edit", { path, old: "every Tuesday morning", new: "every Thursday afternoon", why: "e2e: moved the release day" });
const history = JSON.parse(await call("history", { path }));
check(history.versions.length === 2 && history.versions[0].why === "e2e: moved the release day", "history lists both versions with why");
const old = await call("read", { path, version: history.versions[1].version });
check(old.includes("every Tuesday morning"), "read an old version");
check((await call("read", { path })).includes("every Thursday afternoon"), "read the current version");

await call("delete", { path, why: "e2e: clean up" });
console.log("end-to-end check passed");
await client.close();
