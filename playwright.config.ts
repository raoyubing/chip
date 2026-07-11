import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:5273",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: [
    {
      command: "rm -f apps/server/data/xiaosongshu.e2e.sqlite && DB_PATH=data/xiaosongshu.e2e.sqlite pnpm --filter @xiaosongshu/server demo:load -- --reset && PORT=5274 DB_PATH=data/xiaosongshu.e2e.sqlite pnpm dev:server",
      url: "http://127.0.0.1:5274/api/state",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "VITE_API_TARGET=http://127.0.0.1:5274 pnpm --filter @xiaosongshu/web exec vite --host 127.0.0.1 --port 5273 --strictPort",
      url: "http://127.0.0.1:5273",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
