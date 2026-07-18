// Uptime-scoring parity contract (CLAUDE.md §2.5 DRY).
//
// public/app.js#computeUptime is a deliberate byte-identical copy of
// lib/probe.js#computeUptime — they cannot be shared because app.js is a classic
// non-module <script> and lib/ never ships to the browser. This test guards that
// forced duplication: it extracts app.js's computeUptime source, evaluates it in
// isolation, and asserts it scores identically to the lib implementation across a
// spread of series. Editing one without the other fails here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeUptime as libUptime } from '../lib/probe.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(resolve(__dirname, '..', 'public', 'app.js'), 'utf8');

/** Extract the standalone `computeUptime` function source from the browser script
 *  and materialize it as a callable, so we test the SHIPPED code, not a copy. */
function extractAppUptime() {
  const match = appSrc.match(/function computeUptime\(series\) \{[\s\S]*?\n\}/);
  assert.ok(match, 'could not locate computeUptime in public/app.js');
  return new Function(`${match[0]}\nreturn computeUptime;`)();
}

const appUptime = extractAppUptime();

const S = (...states) => states.map((status) => ({ status }));
const cases = [
  [],
  S('up'),
  S('down'),
  S('degraded'),
  S('up', 'up', 'down'),
  S('up', 'degraded', 'down', 'up'),
  S('degraded', 'degraded', 'degraded'),
  S('up', 'up', 'up', 'up', 'up', 'down', 'degraded'),
];

test('app.js and lib/probe.js computeUptime score identically', () => {
  for (const series of cases) {
    assert.equal(appUptime(series), libUptime(series), `mismatch for ${JSON.stringify(series)}`);
  }
  assert.equal(appUptime([]), null);
  assert.equal(appUptime(null), null);
});
