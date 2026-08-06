import { defineConfig, devices } from "@playwright/test";

const webPort = Number(process.env.E2E_WEB_PORT || 5273);
const serverPort = Number(process.env.E2E_SERVER_PORT || 5274);
const databasePath = `data/xiaosongshu.e2e-${serverPort}.sqlite`;

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: [
    {
      command: `pnpm --filter @xiaosongshu/shared build && rm -f apps/server/${databasePath} && DB_PATH=${databasePath} pnpm --filter @xiaosongshu/server demo:load -- --reset && DEEPSEEK_API_KEY= AUTH_ADMIN_PASSWORD=e2e-admin-password AUTH_GUEST_PASSWORD=e2e-guest-password PORT=${serverPort} DB_PATH=${databasePath} pnpm dev:server`,
      url: `http://127.0.0.1:${serverPort}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `VITE_API_TARGET=http://127.0.0.1:${serverPort} pnpm --filter @xiaosongshu/web exec vite --host 127.0.0.1 --port ${webPort} --strictPort`,
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
