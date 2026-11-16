// Serves the built dashboard: embedded in the compiled program, or from web/dist
// when running from source. Page navigations to unknown paths get index.html (an SPA).
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { NAME } from "./name";

/** URL path -> embedded file. Filled in by server/build.ts when web/dist exists at build time. */
export const embeddedWeb: Record<string, string> = {};

const DIST = join(import.meta.dir, "..", "web", "dist");

function find(pathname: string): string | null {
  if (Object.keys(embeddedWeb).length) return embeddedWeb[pathname] ?? null;
  const full = normalize(join(DIST, decodeURIComponent(pathname)));
  if (!full.startsWith(DIST)) return null;
  return existsSync(full) && statSync(full).isFile() ? full : null;
}

// Text files are gzipped once, on first request, and kept. Embedded files never change;
// from source, a rebuild does, so the key carries the file's modification time.
const COMPRESSIBLE = new Set([".js", ".css", ".html", ".svg", ".json", ".txt", ".map"]);
const gzipped = new Map<string, Uint8Array>();

function gzip(file: string): Uint8Array {
  const key = Object.keys(embeddedWeb).length ? file : `${file}@${statSync(file).mtimeMs}`;
  let body = gzipped.get(key);
  if (!body) gzipped.set(key, (body = Bun.gzipSync(readFileSync(file))));
  return body;
}

function send(req: Request, file: string, headers: Record<string, string>): Response {
  const type = Bun.file(file).type;
  if (!COMPRESSIBLE.has(extname(file))) return new Response(Bun.file(file), { headers: { "Content-Type": type, ...headers } });
  const accepts = /\bgzip\b/.test(req.headers.get("accept-encoding") ?? "");
  return new Response(accepts ? gzip(file) : Bun.file(file), {
    headers: { "Content-Type": type, Vary: "Accept-Encoding", ...(accepts ? { "Content-Encoding": "gzip" } : {}), ...headers },
  });
}

// Notes are written by agents: the page loads no images from other sites (a tracking pixel).
const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-cache",
  "Content-Security-Policy": "img-src 'self' data:",
};

export function serveWeb(req: Request): Response {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const { pathname } = new URL(req.url);
  const page = pathname === "/" || pathname === "/index.html";
  const file = page ? null : find(pathname);
  if (file) {
    // Vite's hashed assets never change; everything else is revalidated.
    const immutable = pathname.startsWith("/assets/");
    return send(req, file, { "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache" });
  }
  // Page navigations (which may carry a note path like /files/shared/a.md) get the app; missing assets get a 404.
  const navigation = (req.headers.get("accept") ?? "").includes("text/html");
  if (!page && !navigation && extname(pathname)) return new Response("Not found", { status: 404 });
  const index = find("/index.html");
  if (index) return send(req, index, PAGE_HEADERS);
  return new Response(`${NAME} is running. The dashboard is not built: run "bun run build".\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
