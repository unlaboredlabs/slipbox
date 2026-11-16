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

test("gzips text files when the browser accepts it, and keeps notes' images to this site", async () => {
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>app</title>");
  writeFileSync(join(dir, "big.js"), "console.log('slipbox');\n".repeat(200));
  embeddedWeb["/index.html"] = join(dir, "index.html");
  embeddedWeb["/assets/big-1.js"] = join(dir, "big.js");
  const get = (path: string, encoding?: string) =>
    serveWeb(new Request("http://x" + path, { headers: { accept: "*/*", ...(encoding ? { "accept-encoding": encoding } : {}) } }));

  const gz = get("/assets/big-1.js", "gzip, deflate, br");
  expect(gz.headers.get("content-encoding")).toBe("gzip");
  expect(gz.headers.get("content-type")).toContain("javascript");
  expect(gz.headers.get("vary")).toBe("Accept-Encoding");
  const bytes = new Uint8Array(await gz.arrayBuffer());
  expect(bytes.length).toBeLessThan(200);
  expect(new TextDecoder().decode(Bun.gunzipSync(bytes))).toBe("console.log('slipbox');\n".repeat(200));

  const plain = get("/assets/big-1.js");
  expect(plain.headers.get("content-encoding")).toBeNull();
  expect((await plain.text()).length).toBe(24 * 200);

  const page = get("/", "gzip");
  expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(page.headers.get("content-security-policy")).toBe("img-src 'self' data:");
  expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await page.arrayBuffer())))).toContain("<title>app</title>");
});
