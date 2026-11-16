import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { fileURLToPath } from "node:url";
import { APP_NAME } from "./src/lib/config.ts";

// In dev, /api goes to the server (or the mock) on PORT, default 7323 like the server.
const apiPort = process.env.PORT ?? "7323";

export default defineConfig({
  // Relative asset paths, so the built files work wherever the server mounts them.
  base: "./",
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    { name: "app-name", transformIndexHtml: (html) => html.replace("%APP_NAME%", APP_NAME) },
  ],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: { "/api": { target: `http://localhost:${apiPort}`, changeOrigin: true } },
  },
});
