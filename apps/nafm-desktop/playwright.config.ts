import { defineConfig } from "@playwright/test";

const baseURL = "http://localhost:14243";

export default defineConfig({
  testDir: "./tests",
  use: { baseURL, browserName: "firefox" },
  webServer: {
    command: "pnpm mock",
    url: `${baseURL}/mock/`,
    reuseExistingServer: true,
  },
});
