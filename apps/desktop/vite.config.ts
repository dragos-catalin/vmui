import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;
// brand/dist/css (tokens + logo motion) is imported from the repo root
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    host: host || false,
    watch: { ignored: ["**/src-tauri/**"] },
    fs: { allow: [repoRoot] },
    // browser harness (?mock=1): reach the Pi's vmui without CORS
    proxy: { "/vmui": { target: "http://192.168.100.232:3737", changeOrigin: true, rewrite: (p) => p.replace(/^\/vmui/, "") } },
  },
  build: { target: "chrome120", minify: "esbuild", sourcemap: false },
});
