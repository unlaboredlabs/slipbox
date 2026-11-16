// The embedding model's own thread (see WorkerEmbedder in embed.ts).
import { LocalEmbedder, serveEmbedder } from "./embed";

serveEmbedder((model, cacheDir) => new LocalEmbedder(model, cacheDir));
