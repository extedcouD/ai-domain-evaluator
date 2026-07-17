import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The KB Studio front-end bundle. The zero-dep node:http server (src/server.ts) stays the JSON API;
 * Vite owns only the browser bundle. In dev, `/api` is proxied to the node API (see src/dev.ts, which
 * boots both); in a build, the server serves the emitted `dist/`.
 */
const apiPort = Number(process.env["KB_API_PORT"] ?? "4318");

export default defineConfig({
  root: "src/ui",
  plugins: [react()],
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
  },
  server: {
    port: Number(process.env["KB_STUDIO_PORT"] ?? "4319"),
    // Fail loudly on a port conflict instead of silently shifting to another port.
    strictPort: true,
    proxy: {
      "/api/": `http://127.0.0.1:${String(apiPort)}`,
    },
  },
});
