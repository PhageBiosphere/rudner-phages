const { defineConfig } = require("@playwright/test");
module.exports = defineConfig({
  testDir: ".", timeout: 30000, fullyParallel: true, reporter: [["list"]],
  use: { baseURL: "http://localhost:4173", channel: process.env.PW_CHANNEL || undefined, viewport: { width: 1400, height: 900 } },
  webServer: { command: "node server.js", port: 4173, reuseExistingServer: true }
});
