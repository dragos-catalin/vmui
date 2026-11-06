import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["node_modules", ".next", "dist"],
    globals: false,
    // DB-backed tests (house, setup, integrations) re-import the sqlite bootstrap per
    // test; under a loaded machine one cold import exceeds the 5 s default.
    testTimeout: 20_000,
    server: {
      deps: {
        // Stub the Next.js "server-only" sentinel module so we can unit-test
        // pure helpers that live next to server-side code.
        inline: ["server-only"],
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "server-only": path.resolve(__dirname, "test/stubs/server-only.ts"),
    },
  },
});
