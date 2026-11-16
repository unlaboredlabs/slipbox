import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NAME } from "../name";
import { embeddedWeb, serveWeb } from "../web";

const dir = mkdtempSync(join(tmpdir(), `${NAME}-web-`));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("serves the dashboard with an SPA fallback for page navigations", async () => {
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>app</title>");
  writeFileSync(join(dir, "app.js"), "console.log(1)");
  embeddedWeb["/index.html"] = join(dir, "index.html");
  embeddedWeb["/assets/app-1.js"] = join(dir, "app.js");
  const get = (path: string, accept = "*/*") => serveWeb(new Request("http://x" + path, { headers: { accept } }));

  const asset = get("/assets/app-1.js");
  expect(asset.status).toBe(200);
  expect(asset.headers.get("cache-control")).toContain("immutable");
  expect(await get("/").text()).toContain("<title>app</title>");
  // A page whose URL carries a note path still gets the app.
  const page = get("/files/shared/notes.md", "text/html,application/xhtml+xml");
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("<title>app</title>");
  expect(get("/assets/missing.js").status).toBe(404);
  expect(get("/", "text/html").status).toBe(200);
  expect(serveWeb(new Request("http://x/", { method: "POST" })).status).toBe(405);
});
