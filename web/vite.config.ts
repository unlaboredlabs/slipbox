import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { fileURLToPath } from "node:url";
import { APP_NAME } from "./src/lib/config.ts";

// In dev, /api goes to the server (or the mock) on PORT, default 7323 like the server.
const apiPort = process.env.PORT ?? "7323";

export default defineConfig({
  // The server mounts the dashboard at /. Absolute asset paths keep a deep URL
  // (/projects/shop/profile.md, from a link in a note) loading the app, not a blank page.
  base: "/",
  plugins: [
    // One bundle: a page not yet visited still opens while the server is down.
    tanstackRouter({ target: "react" }),
    react(),
    tailwindcss(),
    { name: "app-name", transformIndexHtml: (html) => html.replace("%APP_NAME%", APP_NAME) },
  ],
  // The whole app is one bundle on purpose (see above), about 230 kB gzipped.
  build: { chunkSizeWarningLimit: 1000 },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: { "/api": { target: `http://localhost:${apiPort}`, changeOrigin: true } },
  },
});
