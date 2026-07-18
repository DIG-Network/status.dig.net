import { defineConfig, devices } from '@playwright/test';

// Playwright config for the a11y Playwright suite (tests/e2e/*.spec.mjs) —
// distinct from the plain `node --test` unit suite (tests/*.test.js, run via
// `npm test`). This suite drives a REAL headless browser against the built
// static site (dist/), so it exercises the exact artifact users/crawlers get:
// the rendered dashboard DOM (app.js fetches status.json/history.json from the
// served dist/), its ARIA tree, keyboard focus, and axe-core WCAG 2.2 AA rules.
//
// `webServer` serves ./dist with a tiny dependency-free static server
// (scripts/serve-dist.mjs) and waits for it to respond before tests start; the
// build (npm run build → public/ into dist/) must run first (CI does this;
// see package.json / .github/workflows/ci.yml).
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.mjs',
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  timeout: process.env.CI ? 60_000 : 30_000,
  forbidOnly: !!process.env.CI,
  // Flaky-test management (#489): surface intermittent a11y/browser flakiness
  // via automatic re-run instead of a hard fail on the first try.
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4321',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node scripts/serve-dist.mjs',
    url: 'http://127.0.0.1:4321',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
