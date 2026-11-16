// End-to-end check against a running server with the official MCP client:
//   bun server/e2e.ts <url> <agent key> [--words-only]
// Writes a note under agents/e2e/, finds it by a word and by a paraphrase,
// edits it, reads its history, an old version and its folder's changes, then deletes it.
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
const note = "# Office pets\n\nOur office dog is a golden retriever named Biscuit who loves playing fetch in the yard.\n";

const start = await call("start", {});
check(start.startsWith("You are ") && start.includes("# Profiles") && start.includes("# Map of /"), "start says who you are, the profiles and the map", start);
const written = await call("write", { path, content: note, why: "e2e: create a note" });
check(/^Saved \S+, version [0-9a-f]{12}\.$/.test(written), `write ${path} is saved with a version`, written);

/** The search reply's block for `path`: "## path  date", its line ranges with how they matched, a snippet. */
const block = (reply: string) => reply.split("\n\n").find((b) => b.startsWith(`## ${path}`));
const words = await call("search", { query: "golden retriever fetch", path: "agents/e2e" });
check(block(words)?.includes("[words]") || block(words)?.includes("[both]"), "search by a word finds it", words);

if (!wordsOnly) {
  // The embedding is queued after the write; give it a moment to land.
  let hit: string | undefined;
  let reply = "";
  for (let i = 0; i < 100 && !hit; i++) {
    reply = await call("search", { query: "which canine lives at the workplace?", path: "agents/e2e" });
    hit = block(reply)?.includes("[meaning]") ? block(reply) : undefined;
    if (!hit) await Bun.sleep(300);
  }
  check(hit && reply.startsWith(`## ${path}`), "search by a paraphrase finds it by meaning alone", reply);
}

await call("edit", { path, old: "golden retriever", new: "black labrador", why: "e2e: it is a labrador" });
const history = (await call("history", { path })).split("\n");
check(history.length === 2 && history[0].endsWith(": e2e: it is a labrador"), "history lists both versions with why", history);
const old = await call("read", { path, version: history[1].split(" ")[0] });
check(old.includes("golden retriever"), "read an old version");
check((await call("read", { path })).includes("black labrador"), "read the current version");
check((await call("history", { path: "agents/e2e" })).includes(`${path}: e2e: it is a labrador`), "history of a folder lists the change");

await call("delete", { path, why: "e2e: clean up" });
console.log("end-to-end check passed");
await client.close();
