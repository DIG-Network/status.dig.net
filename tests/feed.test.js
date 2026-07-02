// Unit tests for buildFeed() — the pure Atom-feed projection over the rolling
// per-system history (lib/probe.js). status.dig.net's incident/status history
// is exactly the kind of content CLAUDE.md §6.6 wants a feed for: readers
// (feed apps, agents, monitoring bots) subscribe once and get pushed each
// state TRANSITION (up->down, down->degraded, ...) instead of polling
// history.json and diffing it themselves. Pure/I/O-free like the rest of
// lib/probe.js: takes a history map + statusDoc, returns an XML string.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildFeed, appendHistory, buildStatus, shapeResult, STATUS } from '../lib/probe.js';

function sys(id, status, t) {
  return shapeResult({ id, name: `${id}.dig.net`, category: 'Read path', status, latencyMs: 10, checkedAt: t, detail: { kind: 'http', httpStatus: status === STATUS.UP ? 200 : 500 } });
}

test('buildFeed: well-formed Atom XML with required feed-level elements', () => {
  const history = { rpc: [{ t: '2026-06-01T00:00:00.000Z', status: 'up', latencyMs: 10 }] };
  const doc = buildStatus({ generatedAt: '2026-06-01T00:05:00.000Z', systems: [sys('rpc', STATUS.UP, '2026-06-01T00:05:00.000Z')] });
  const xml = buildFeed(history, doc);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/);
  assert.match(xml, /<id>https:\/\/status\.dig\.net\/<\/id>/);
  assert.match(xml, /<title>DIG Network Status<\/title>/);
  assert.match(xml, /<updated>2026-06-01T00:05:00\.000Z<\/updated>/);
  assert.match(xml, /<link[^>]*rel="self"[^>]*href="https:\/\/status\.dig\.net\/feed\.xml"/);
});

test('buildFeed: emits one entry per detected state transition, not per sample', () => {
  const history = {
    rpc: [
      { t: '2026-06-01T00:00:00.000Z', status: 'up', latencyMs: 10 },
      { t: '2026-06-01T00:05:00.000Z', status: 'up', latencyMs: 12 },
      { t: '2026-06-01T00:10:00.000Z', status: 'down', latencyMs: 0 },
      { t: '2026-06-01T00:15:00.000Z', status: 'down', latencyMs: 0 },
      { t: '2026-06-01T00:20:00.000Z', status: 'up', latencyMs: 11 },
    ],
  };
  const doc = buildStatus({ generatedAt: '2026-06-01T00:20:00.000Z', systems: [sys('rpc', STATUS.UP, '2026-06-01T00:20:00.000Z')] });
  const xml = buildFeed(history, doc);
  const entries = xml.match(/<entry>/g) || [];
  // Two transitions: up->down at 00:10, down->up at 00:20. The very first
  // sample is a baseline, not a transition, so it does not emit an entry.
  assert.equal(entries.length, 2);
  assert.match(xml, /rpc\.dig\.net is now down/);
  assert.match(xml, /rpc\.dig\.net recovered/);
});

test('buildFeed: escapes XML-significant characters in entry content', () => {
  const history = { rpc: [{ t: '2026-06-01T00:00:00.000Z', status: 'up' }, { t: '2026-06-01T00:05:00.000Z', status: 'down' }] };
  const doc = buildStatus({ generatedAt: '2026-06-01T00:05:00.000Z', systems: [{ ...sys('rpc', STATUS.DOWN, '2026-06-01T00:05:00.000Z'), name: 'A & B <rpc>' }] });
  const xml = buildFeed(history, doc);
  assert.doesNotMatch(xml, /A & B <rpc>/);
  assert.match(xml, /A &amp; B &lt;rpc&gt;/);
});

test('buildFeed: no history/no transitions still produces a valid empty feed', () => {
  const doc = buildStatus({ generatedAt: '2026-06-01T00:00:00.000Z', systems: [sys('rpc', STATUS.UP, '2026-06-01T00:00:00.000Z')] });
  const xml = buildFeed({}, doc);
  assert.match(xml, /<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/);
  assert.doesNotMatch(xml, /<entry>/);
});

test('buildFeed: composes with appendHistory (integration of the two pure helpers)', () => {
  let history = {};
  let doc = buildStatus({ generatedAt: '2026-06-01T00:00:00.000Z', systems: [sys('rpc', STATUS.UP, '2026-06-01T00:00:00.000Z')] });
  history = appendHistory(history, doc);
  doc = buildStatus({ generatedAt: '2026-06-01T00:05:00.000Z', systems: [sys('rpc', STATUS.DOWN, '2026-06-01T00:05:00.000Z')] });
  history = appendHistory(history, doc);
  const xml = buildFeed(history, doc);
  assert.match(xml, /<entry>/);
});
