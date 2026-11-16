// Native files of the embedding runtime (onnxruntime) for the compiled program.
// Empty when running from source. server/build.ts replaces this module with one
// that embeds the files, and they are written next to each other on first use,
// because the runtime's binding loads its shared library from its own folder.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const nativeFiles: { name: string; path: string }[] = [];

/** Writes the embedded native files to `dir` (once) and tells the patched binding where they are. */
export async function prepareNativeRuntime(dir: string) {
  if (!nativeFiles.length) return;
  const binding = nativeFiles[0]; // the build puts the binding first
  const sizes = nativeFiles.map((f) => Bun.file(f.path).size).join("-");
  const target = join(dir, sizes);
  mkdirSync(target, { recursive: true });
  for (const f of nativeFiles) {
    const to = join(target, f.name);
    if (existsSync(to) && statSync(to).size === Bun.file(f.path).size) continue;
    await Bun.write(to + ".tmp", Bun.file(f.path));
    renameSync(to + ".tmp", to);
  }
  // Copies written by earlier releases (another runtime version) are never used again.
  for (const old of readdirSync(dir)) if (old !== sizes) rmSync(join(dir, old), { recursive: true, force: true });
  (globalThis as any).__ORT_BINDING_PATH__ = join(target, binding.name);
}
