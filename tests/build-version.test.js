// CLAUDE.md §6.7 — the build's semver must never drift from package.json. scripts/build.js
// substitutes the %%APP_VERSION%% placeholder (public/index.html, public/app.js) with the real
// version when it copies public/ -> dist/. This test runs the REAL build script (exactly as CI
// invokes it, `node scripts/build.js`) and asserts dist/ carries the actual version, not the
// placeholder — a regression here would mean status.dig.net silently ships an unversioned build.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIST = resolve(ROOT, 'dist');

test('build.js injects the real package.json version into dist/index.html and dist/app.js', () => {
  execFileSync(process.execPath, [resolve(ROOT, 'scripts', 'build.js')], { cwd: ROOT, stdio: 'pipe' });

  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version;
  assert.match(version, /^\d+\.\d+\.\d+/);

  const html = readFileSync(resolve(DIST, 'index.html'), 'utf8');
  assert.ok(!html.includes('%%APP_VERSION%%'), 'placeholder must not survive the build');
  assert.match(html, new RegExp(`<meta name="app-version" content="${version.replace(/\./g, '\\.')}"`));
  assert.match(html, new RegExp(`data-testid="footer-app-version"[^>]*>v${version.replace(/\./g, '\\.')}<`));

  const js = readFileSync(resolve(DIST, 'app.js'), 'utf8');
  assert.ok(!js.includes('%%APP_VERSION%%'), 'placeholder must not survive the build');
  assert.match(js, new RegExp(`window\\.__APP_VERSION__ = ['"]${version.replace(/\./g, '\\.')}['"]`));
});
