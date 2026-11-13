import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', timeout: 60_000, expect: { timeout: 12_000 },
  fullyParallel: false, workers: 1, reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5173', headless: true, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'npm run dev', url: 'http://127.0.0.1:5173', reuseExistingServer: !process.env.CI, timeout: 90_000 },
});
