// Serves the built dashboard: embedded in the compiled program, or from web/dist
// when running from source. Unknown paths fall back to index.html (an SPA).
import { existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { NAME } from "./name";

/** URL path -> embedded file. Filled in by server/build.ts when web/dist exists at build time. */
export const embeddedWeb: Record<string, string> = {};

const DIST = join(import.meta.dir, "..", "web", "dist");

function find(pathname: string): Blob | null {
  if (Object.keys(embeddedWeb).length) {
    const hit = embeddedWeb[pathname];
    return hit ? Bun.file(hit) : null;
  }
  const full = normalize(join(DIST, decodeURIComponent(pathname)));
  if (!full.startsWith(DIST)) return null;
  return existsSync(full) && statSync(full).isFile() ? Bun.file(full) : null;
}

export function hasDashboard(): boolean {
  return Object.keys(embeddedWeb).length > 0 || existsSync(join(DIST, "index.html"));
}

export function serveWeb(req: Request): Response {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const { pathname } = new URL(req.url);
  const file = find(pathname);
  if (file) {
    // Vite's hashed assets never change; everything else is revalidated.
    const immutable = pathname.startsWith("/assets/");
    return new Response(file, { headers: { "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache" } });
  }
  if (extname(pathname) && pathname !== "/") return new Response("Not found", { status: 404 });
  const index = find("/index.html");
  if (index) return new Response(index, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
  return new Response(`${NAME} is running. The dashboard is not built: run "bun run build:web".\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
