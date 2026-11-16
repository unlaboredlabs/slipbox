// Builds the single program with `bun build --compile`:
//   bun run build [--release] [--target bun-linux-arm64] [--outfile dist/slipbox] [--skip-web]
//
// - Builds web/ first when it exists, and embeds web/dist.
// - Embeds the embedding runtime's native files (onnxruntime) for the target,
//   which server/native.ts writes to disk on first use.
// - Stubs `sharp`, an image library @huggingface/transformers imports but text
//   embeddings never use.
// - --release stamps the version: the number of commits on main, the commit and the date.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { BunPlugin } from "bun";
import { NAME } from "./name";

const root = resolve(import.meta.dir, "..");
const { values: args } = parseArgs({
  options: {
    release: { type: "boolean", default: false },
    target: { type: "string" },
    outfile: { type: "string" },
    "skip-web": { type: "boolean", default: false },
  },
});

const target = args.target ?? `bun-${process.platform}-${process.arch}`;
const [, os, arch] = target.split("-");
const outfile = resolve(args.outfile ?? join(root, "dist", NAME));

async function run(cmd: string[], cwd = root): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "inherit" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`${cmd.join(" ")} failed`);
  return out.trim();
}

// 1. The dashboard.
const web = join(root, "web");
if (!args["skip-web"] && existsSync(join(web, "package.json"))) {
  console.log("building web/ ...");
  await run(["bun", "install", "--frozen-lockfile"], web).catch(() => run(["bun", "install"], web));
  await run(["bun", "run", "build"], web);
}
const dist = join(web, "dist");
const webFiles = existsSync(join(dist, "index.html")) ? walk(dist) : [];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

// 2. The native runtime for the target.
const nativeDir = join(root, "node_modules/onnxruntime-node/bin/napi-v6", os, arch);
const nativeNames = existsSync(nativeDir)
  ? [
      "onnxruntime_binding.node", // first: server/native.ts loads it
      ...readdirSync(nativeDir).filter((n) => /^libonnxruntime\.so\.1$|^libonnxruntime\.1\.dylib$/.test(n)),
    ]
  : [];
if (!nativeNames.length) console.warn(`no embedding runtime for ${os}-${arch}: this build searches by words only`);

// 3. The version.
let version = { VERSION: "dev", COMMIT: "", BUILD_DATE: "" };
if (args.release) {
  version = {
    VERSION: await run(["git", "rev-list", "--count", "HEAD"]),
    COMMIT: await run(["git", "rev-parse", "--short=7", "HEAD"]),
    BUILD_DATE: new Date().toISOString().slice(0, 10),
  };
}

const fileImports = (files: { name: string; path: string }[]) =>
  files.map((f, i) => `import f${i} from ${JSON.stringify(f.path)} with { type: "file" };`).join("\n");

const plugin: BunPlugin = {
  name: "compile",
  setup(build) {
    build.onResolve({ filter: /^sharp$/ }, () => ({ path: "sharp", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export default {};", loader: "js" }));

    // transformers loads onnxruntime-node with a runtime require the bundler cannot see; make it an import.
    build.onLoad({ filter: /transformers\.node\.mjs$/ }, async ({ path }) => {
      const from = 'var onnx_node_default = requireFromHere("onnxruntime-node");';
      const src = await Bun.file(path).text();
      if (!src.includes(from)) throw new Error("@huggingface/transformers changed how it loads onnxruntime-node; update server/build.ts");
      return { contents: src.replace(from, 'import __ort from "onnxruntime-node";\nvar onnx_node_default = __ort;'), loader: "js" };
    });

    // onnxruntime-node's binding: load the copy server/native.ts wrote to disk.
    build.onLoad({ filter: /onnxruntime-node[\\/]dist[\\/]binding\.js$/ }, async ({ path }) => {
      const src = await Bun.file(path).text();
      const load = `(() => {
        const at = globalThis.__ORT_BINDING_PATH__;
        if (!at) throw new Error("this build has no embedding runtime for ${os}-${arch}; search uses words only");
        const m = { exports: {} };
        process.dlopen(m, at);
        return m.exports;
      })()`;
      const out = src.replace(/require\(`\.\.\/bin\/napi-v6\/[^`]*`\)/, load);
      if (out === src) throw new Error("onnxruntime-node changed how it loads its binding; update server/build.ts");
      return { contents: out, loader: "js" };
    });

    build.onLoad({ filter: /server[\\/]native\.ts$/ }, async ({ path }) => {
      const files = nativeNames.map((name) => ({ name, path: join(nativeDir, name) }));
      const list = files.map((f, i) => `{ name: ${JSON.stringify(f.name)}, path: f${i} }`).join(", ");
      const src = (await Bun.file(path).text()).replace(
        "export const nativeFiles: { name: string; path: string }[] = [];",
        `${fileImports(files)}\nexport const nativeFiles: { name: string; path: string }[] = [${list}];`,
      );
      return { contents: src, loader: "ts" };
    });

    build.onLoad({ filter: /server[\\/]web\.ts$/ }, async ({ path }) => {
      const files = webFiles.map((p) => ({ name: "/" + relative(dist, p).split("\\").join("/"), path: p }));
      const map = files.map((f, i) => `${JSON.stringify(f.name)}: f${i}`).join(", ");
      const src = (await Bun.file(path).text()).replace(
        "export const embeddedWeb: Record<string, string> = {};",
        `${fileImports(files)}\nexport const embeddedWeb: Record<string, string> = { ${map} };`,
      );
      return { contents: src, loader: "ts" };
    });

    build.onLoad({ filter: /server[\\/]version\.ts$/ }, async ({ path }) => {
      let src = await Bun.file(path).text();
      for (const [k, v] of Object.entries(version)) {
        src = src.replace(new RegExp(`export const ${k}: string = "[^"]*";`), `export const ${k}: string = ${JSON.stringify(v)};`);
      }
      return { contents: src, loader: "ts" };
    });
  },
};

const result = await Bun.build({
  entrypoints: [join(root, "server/cli.ts")],
  compile: { target: target as any, outfile },
  minify: true,
  plugins: [plugin],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(
  `built ${relative(process.cwd(), outfile)} (${target}, version ${version.VERSION}` +
    `, dashboard ${webFiles.length ? "embedded" : "not built"}, embedding runtime ${nativeNames.length ? "embedded" : "none"})`,
);
