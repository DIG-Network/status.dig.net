// Monitored-systems doc-parity contract (CLAUDE.md §6.6: "stale is a bug").
//
// lib/targets.js is the single source of truth for WHAT status.dig.net monitors.
// The human/agent-facing catalogues — public/llms.txt ("## Monitored systems")
// and the README "What it monitors" table — must list EVERY monitored system, so
// a new target can never silently go undocumented. This test derives the list
// from TARGETS and asserts each system's stable id + display name appears in both
// documents; adding a target without documenting it fails CI here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGETS } from '../lib/targets.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

test('public/llms.txt "Monitored systems" lists every target id + name', () => {
  const llms = read('public/llms.txt');
  for (const { id, name } of TARGETS) {
    assert.ok(llms.includes(id), `llms.txt is missing monitored system id "${id}"`);
    assert.ok(llms.includes(name), `llms.txt is missing monitored system name "${name}"`);
  }
});

test('README "What it monitors" table lists every target name', () => {
  const readme = read('README.md');
  for (const { name } of TARGETS) {
    assert.ok(readme.includes(name), `README is missing monitored system "${name}"`);
  }
});
