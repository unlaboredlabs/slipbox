// A stand-in for the model on WorkerEmbedder's thread: it holds its thread for
// SLOW_MS per batch, as a real model does, and stops its thread on "crash".
import { type Embedder, serveEmbedder } from "../../index/embed";

const SLOW_MS = 300;

class SlowEmbedder implements Embedder {
  readonly model = "test/slow";
  async load() {}
  async embed(texts: string[]) {
    if (texts.includes("crash")) process.exit(1);
    const end = performance.now() + SLOW_MS;
    while (performance.now() < end); // busy, like inference: nothing else runs on this thread meanwhile
    return texts.map((t) => {
      const v = new Float32Array(8);
      v[t.length % 8] = 1;
      return v;
    });
  }
}

serveEmbedder(() => new SlowEmbedder());
