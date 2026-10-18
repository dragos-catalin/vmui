import { defineConfig, devices } from "@playwright/test";

const PORT = 3737;
// PW_BASE_URL = an already-running server (cloud e2e VM: scripts/e2e-cloud/vm-run.sh) -> no webServer.
const EXTERNAL = process.env.PW_BASE_URL;
const BASE_URL = EXTERNAL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: EXTERNAL
    ? undefined
    : {
        command: "pnpm dev",
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
