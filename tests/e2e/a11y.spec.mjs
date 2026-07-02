import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// WCAG 2.2 AA automated audit (§6.6 of the umbrella project's frontend
// baseline) — runs axe-core against the built static site (served by
// scripts/serve-dist.mjs, see playwright.config.mjs) at BOTH a desktop and a
// mobile viewport, asserting ZERO violations. status.dig.net is a single-page
// dashboard, so the route matrix is just "/", but it is audited in its REAL
// rendered state: app.js fetches the committed status.json/history.json and
// injects the per-system rows, so the audit covers the actual content DOM
// (row names/descriptions/uptime/latency text — where a low-contrast token
// would surface), not just the loading shell.
//
// This is the "concrete automated AT tier" the baseline requires (not a linter
// or a source-regex check): a real headless browser + the axe rule engine over
// the hydrated accessibility tree. The keyboard-focus and ARIA-tree assertions
// below cover a couple of things plain axe rules can't (skip-link operability,
// the async status region being exposed as a live region).

const DESKTOP = { width: 1280, height: 900 };
const MOBILE = { width: 390, height: 844 };

const VIEWPORTS = [
  { name: 'desktop', size: DESKTOP },
  { name: 'mobile', size: MOBILE },
];

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/**
 * Load the dashboard and wait for it to reach its real, settled rendered state:
 * the overall banner resolved off its loading class AND the per-system rows
 * injected. Auditing the loading shell would miss the content-area DOM (the
 * row text is what carries the color-contrast-sensitive muted tokens).
 */
async function loadDashboard(page) {
  await page.goto('/');
  await page.waitForSelector('#main-content');
  // app.js fetches status.json then renders rows with data-testid="system-row".
  await page.waitForSelector('[data-testid="system-row"]');
  // The overall banner drops its .is-loading class once the snapshot resolves.
  await page.waitForFunction(() => {
    const el = document.querySelector('#overall');
    return el && !el.classList.contains('is-loading');
  });
}

function assertNoViolations(results, label) {
  if (results.violations.length > 0) {
    const summary = results.violations
      .map(
        (v) =>
          `${v.id} (${v.impact}): ${v.description} — ${v.nodes.length} node(s): ${v.nodes
            .map((n) => n.target.join(' '))
            .join(', ')}`,
      )
      .join('\n');
    throw new Error(`axe found ${results.violations.length} violation(s) on ${label}:\n${summary}`);
  }
  expect(results.violations).toEqual([]);
}

for (const { name, size } of VIEWPORTS) {
  test(`axe: zero WCAG 2.2 AA violations on the dashboard (${name})`, async ({ page }) => {
    await page.setViewportSize(size);
    await loadDashboard(page);
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    assertNoViolations(results, `/ (${name})`);
  });
}

test('the async status region is exposed as a live region to assistive tech', async ({ page }) => {
  await loadDashboard(page);
  const overall = page.locator('#overall');
  await expect(overall).toHaveAttribute('role', 'status');
  await expect(overall).toHaveAttribute('aria-live', 'polite');
  // Machine hooks the baseline (agent-friendly) promises are present too.
  await expect(overall).toHaveAttribute('data-overall', /up|degraded|down/);
});

test('the skip-to-content link is keyboard-focusable and targets the main landmark', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('#main-content');
  // First Tab reaches the skip link (it is the first focusable element).
  await page.keyboard.press('Tab');
  const skip = page.locator('a.skip-link');
  await expect(skip).toBeFocused();
  await expect(skip).toHaveAttribute('href', '#main-content');
  await expect(page.locator('main#main-content')).toHaveCount(1);
});

test('the accessibility tree exposes the expected landmarks and single h1', async ({ page }) => {
  await loadDashboard(page);
  // Exactly one h1 (the sr-only page title), a banner, a main, and a contentinfo.
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('banner')).toHaveCount(1);
  await expect(page.getByRole('main')).toHaveCount(1);
  await expect(page.getByRole('contentinfo')).toHaveCount(1);
});
