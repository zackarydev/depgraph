import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/visual',
  testMatch: '**/*.test.mjs',
  timeout: 30000,
  use: {
    headless: true,
    viewport: { width: 800, height: 600 },
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
