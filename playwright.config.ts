import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: '*.e2e.ts',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:3210', channel: 'chrome', serviceWorkers: 'block', viewport: { width: 430, height: 932 } },
  webServer: { command: 'npm run start -- --hostname 127.0.0.1 --port 3210', url: 'http://127.0.0.1:3210', reuseExistingServer: false },
})
