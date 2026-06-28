// Unit tests for the pure probe/health-classification + status.json shaping
// logic (lib/probe.js). These are deliberately I/O-free: every function under
// test takes plain inputs (a fetch-result-shaped object, a timestamp, a prior
// history) and returns plain data, so the scheduled workflow's networking is
// kept entirely out of the tested surface. Run with `npm test` (node --test).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classify,
  classifyHttp,
  classifyJsonRpc,
  classifyChainView,
  classifyPeakFreshness,
  shapeResult,
  buildStatus,
  buildHealth,
  appendHistory,
  computeUptime,
  STATUS,
  SCHEMA_VERSION,
  ERROR_CODE,
} from '../lib/probe.js';

// ---------------------------------------------------------------------------
// classify() — the core up/degraded/down decision from a probe outcome.
// ---------------------------------------------------------------------------
test('classify: ok within latency budget is "up"', () => {
  assert.equal(classify({ ok: true, latencyMs: 120 }), STATUS.UP);
});

test('classify: ok but slow (over degradedMs) is "degraded"', () => {
  assert.equal(
    classify({ ok: true, latencyMs: 5000 }, { degradedMs: 2000 }),
    STATUS.DEGRADED
  );
});

test('classify: not ok is "down"', () => {
  assert.equal(classify({ ok: false, latencyMs: 50 }), STATUS.DOWN);
});

test('classify: explicit degraded flag wins even when ok', () => {
  assert.equal(classify({ ok: true, latencyMs: 10, degraded: true }), STATUS.DEGRADED);
});

// ---------------------------------------------------------------------------
// classifyHttp() — HTTP 200 + cert. 2xx is up; 5xx is down; 3xx/4xx degraded.
// ---------------------------------------------------------------------------
test('classifyHttp: 200 is up', () => {
  assert.deepEqual(classifyHttp({ status: 200, latencyMs: 80 }), { status: STATUS.UP, ok: true });
});

test('classifyHttp: 503 is down', () => {
  const r = classifyHttp({ status: 503, latencyMs: 80 });
  assert.equal(r.status, STATUS.DOWN);
  assert.equal(r.ok, false);
});

test('classifyHttp: 404 is degraded (reachable, wrong response)', () => {
  assert.equal(classifyHttp({ status: 404, latencyMs: 80 }).status, STATUS.DEGRADED);
});

test('classifyHttp: network error (no status) is down', () => {
  assert.equal(classifyHttp({ error: 'ECONNREFUSED' }).status, STATUS.DOWN);
});

// ---------------------------------------------------------------------------
// classifyJsonRpc() — a dig JSON-RPC health probe (e.g. dig.methods /
// dig.getAnchoredRoot). A well-formed JSON-RPC result object is up; a
// JSON-RPC error object means the service answered but rejected → degraded;
// transport failure → down.
// ---------------------------------------------------------------------------
test('classifyJsonRpc: result present is up', () => {
  const r = classifyJsonRpc({ status: 200, body: { jsonrpc: '2.0', id: 1, result: ['dig.getContent'] }, latencyMs: 90 });
  assert.equal(r.status, STATUS.UP);
});

test('classifyJsonRpc: jsonrpc error object is degraded', () => {
  const r = classifyJsonRpc({ status: 200, body: { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } }, latencyMs: 90 });
  assert.equal(r.status, STATUS.DEGRADED);
});

test('classifyJsonRpc: non-200 transport is down', () => {
  assert.equal(classifyJsonRpc({ status: 502, latencyMs: 90 }).status, STATUS.DOWN);
});

test('classifyJsonRpc: malformed body (not jsonrpc) is degraded', () => {
  assert.equal(classifyJsonRpc({ status: 200, body: { hello: 'world' }, latencyMs: 90 }).status, STATUS.DEGRADED);
});

// ---------------------------------------------------------------------------
// classifyChainView() — coinset.org ChainView/blockchain-state probe. We pull
// the peak height and surface it; reachable + sane height is up.
// ---------------------------------------------------------------------------
test('classifyChainView: blockchain_state with peak height is up and extracts height', () => {
  const body = { blockchain_state: { peak: { height: 6543210 }, sync: { synced: true } } };
  const r = classifyChainView({ status: 200, body, latencyMs: 110 });
  assert.equal(r.status, STATUS.UP);
  assert.equal(r.detail.peakHeight, 6543210);
});

test('classifyChainView: node reports not synced is degraded', () => {
  const body = { blockchain_state: { peak: { height: 10 }, sync: { synced: false } } };
  assert.equal(classifyChainView({ status: 200, body, latencyMs: 110 }).status, STATUS.DEGRADED);
});

test('classifyChainView: missing peak is down', () => {
  assert.equal(classifyChainView({ status: 200, body: {}, latencyMs: 110 }).status, STATUS.DOWN);
});

// ---------------------------------------------------------------------------
// classifyPeakFreshness() — Chia mainnet liveness derived from how recently
// the coinset peak advanced. Chia targets ~18.75s/block; if the peak height
// hasn't moved across two consecutive probes far apart in wall-clock time, the
// chain (or our view of it) is stale.
// ---------------------------------------------------------------------------
test('classifyPeakFreshness: peak advanced since last probe is up', () => {
  const r = classifyPeakFreshness({ height: 100, prevHeight: 90, secondsSincePrev: 600 });
  assert.equal(r.status, STATUS.UP);
});

test('classifyPeakFreshness: peak stuck for far longer than a block is degraded', () => {
  // No advance across 30 minutes (~96 expected blocks) → stale.
  const r = classifyPeakFreshness({ height: 100, prevHeight: 100, secondsSincePrev: 1800 });
  assert.equal(r.status, STATUS.DEGRADED);
});

test('classifyPeakFreshness: brief no-advance within a couple blocks is up', () => {
  const r = classifyPeakFreshness({ height: 100, prevHeight: 100, secondsSincePrev: 20 });
  assert.equal(r.status, STATUS.UP);
});

test('classifyPeakFreshness: no prior height yet (first run) is up if height present', () => {
  assert.equal(classifyPeakFreshness({ height: 100, prevHeight: null, secondsSincePrev: null }).status, STATUS.UP);
});

// ---------------------------------------------------------------------------
// shapeResult() — assemble a single per-system status record for status.json.
// ---------------------------------------------------------------------------
test('shapeResult: produces a complete normalized record', () => {
  const rec = shapeResult({
    id: 'rpc',
    name: 'rpc.dig.net',
    category: 'read',
    status: STATUS.UP,
    latencyMs: 123,
    checkedAt: '2026-06-28T00:00:00.000Z',
    detail: { method: 'dig.getContent' },
  });
  assert.equal(rec.id, 'rpc');
  assert.equal(rec.name, 'rpc.dig.net');
  assert.equal(rec.status, STATUS.UP);
  assert.equal(rec.latencyMs, 123);
  assert.equal(rec.checkedAt, '2026-06-28T00:00:00.000Z');
  assert.deepEqual(rec.detail, { method: 'dig.getContent' });
});

test('shapeResult: clamps absurd/negative latency to >= 0', () => {
  const rec = shapeResult({ id: 'x', name: 'x', status: STATUS.UP, latencyMs: -5, checkedAt: 't' });
  assert.equal(rec.latencyMs, 0);
});

// ---------------------------------------------------------------------------
// classifyHttp() — optional targets. An OPTIONAL endpoint that may not be
// provisioned yet (e.g. cdn.dig.net before its DNS exists) must NOT read as a
// hard outage: an unreachable optional is "degraded" (unknown), not "down". A
// reachable optional still classifies normally.
// ---------------------------------------------------------------------------
test('classifyHttp: unreachable OPTIONAL target is degraded, not down', () => {
  const r = classifyHttp({ error: 'fetch failed' }, { optional: true });
  assert.equal(r.status, STATUS.DEGRADED);
  assert.equal(r.ok, false);
});

test('classifyHttp: optional 5xx is still degraded (not a hard down)', () => {
  assert.equal(classifyHttp({ status: 503, latencyMs: 80 }, { optional: true }).status, STATUS.DEGRADED);
});

test('classifyHttp: reachable optional 200 is up', () => {
  assert.equal(classifyHttp({ status: 200, latencyMs: 80 }, { optional: true }).status, STATUS.UP);
});

// ---------------------------------------------------------------------------
// buildStatus() — the top-level status.json document. Overall status is the
// worst of the components (down > degraded > up), with summary counts.
// ---------------------------------------------------------------------------
test('buildStatus: a system flagged excludeFromOverall does not drag overall', () => {
  const doc = buildStatus({
    generatedAt: 't',
    systems: [
      shapeResult({ id: 'a', name: 'A', status: STATUS.UP, latencyMs: 10, checkedAt: 't' }),
      // An optional/not-yet-provisioned system marked excluded from the rollup.
      { ...shapeResult({ id: 'cdn', name: 'cdn', status: STATUS.DEGRADED, latencyMs: 10, checkedAt: 't' }), excludeFromOverall: true },
    ],
  });
  assert.equal(doc.overall, STATUS.UP);
  // It still appears in the summary counts (visible to users), just not in overall.
  assert.equal(doc.summary.total, 2);
});

test('buildStatus: overall is worst-of components', () => {
  const doc = buildStatus({
    generatedAt: '2026-06-28T00:00:00.000Z',
    systems: [
      shapeResult({ id: 'a', name: 'A', status: STATUS.UP, latencyMs: 10, checkedAt: 't' }),
      shapeResult({ id: 'b', name: 'B', status: STATUS.DEGRADED, latencyMs: 10, checkedAt: 't' }),
      shapeResult({ id: 'c', name: 'C', status: STATUS.DOWN, latencyMs: 10, checkedAt: 't' }),
    ],
  });
  assert.equal(doc.overall, STATUS.DOWN);
  assert.deepEqual(doc.summary, { up: 1, degraded: 1, down: 1, total: 3 });
  assert.equal(doc.generatedAt, '2026-06-28T00:00:00.000Z');
});

test('buildStatus: all up → overall up', () => {
  const doc = buildStatus({
    generatedAt: 't',
    systems: [
      shapeResult({ id: 'a', name: 'A', status: STATUS.UP, latencyMs: 10, checkedAt: 't' }),
      shapeResult({ id: 'b', name: 'B', status: STATUS.UP, latencyMs: 10, checkedAt: 't' }),
    ],
  });
  assert.equal(doc.overall, STATUS.UP);
});

test('buildStatus: degraded but none down → overall degraded', () => {
  const doc = buildStatus({
    generatedAt: 't',
    systems: [
      shapeResult({ id: 'a', name: 'A', status: STATUS.UP, latencyMs: 10, checkedAt: 't' }),
      shapeResult({ id: 'b', name: 'B', status: STATUS.DEGRADED, latencyMs: 10, checkedAt: 't' }),
    ],
  });
  assert.equal(doc.overall, STATUS.DEGRADED);
});

// ---------------------------------------------------------------------------
// schemaVersion — the status.json document carries a documented, versioned
// machine-schema contract so an agent can detect a breaking change. It must be
// a positive integer and appear at the TOP of the document (before overall).
// ---------------------------------------------------------------------------
test('SCHEMA_VERSION is a positive integer', () => {
  assert.equal(typeof SCHEMA_VERSION, 'number');
  assert.ok(Number.isInteger(SCHEMA_VERSION) && SCHEMA_VERSION >= 1);
});

test('buildStatus: emits schemaVersion equal to SCHEMA_VERSION', () => {
  const doc = buildStatus({
    generatedAt: '2026-06-28T00:00:00.000Z',
    systems: [shapeResult({ id: 'a', name: 'A', status: STATUS.UP, latencyMs: 10, checkedAt: 't' })],
  });
  assert.equal(doc.schemaVersion, SCHEMA_VERSION);
  // schemaVersion is the first key so the contract version is discoverable up-front.
  assert.equal(Object.keys(doc)[0], 'schemaVersion');
});

// ---------------------------------------------------------------------------
// buildHealth() — a tiny machine summary for quick agent polling. It carries
// the schemaVersion, the overall rollup, generatedAt, and a flat {id:status}
// map (no per-system latency/history/detail). It must be derivable from a
// status doc alone, and stay consistent with buildStatus's overall.
// ---------------------------------------------------------------------------
test('buildHealth: summarizes a status doc into {schemaVersion, overall, generatedAt, systems:{id:status}}', () => {
  const doc = buildStatus({
    generatedAt: '2026-06-28T00:00:00.000Z',
    systems: [
      shapeResult({ id: 'rpc', name: 'rpc.dig.net', status: STATUS.UP, latencyMs: 10, checkedAt: 't' }),
      shapeResult({ id: 'cdn', name: 'cdn.dig.net', status: STATUS.DEGRADED, latencyMs: 10, checkedAt: 't' }),
    ],
  });
  const health = buildHealth(doc);
  assert.equal(health.schemaVersion, SCHEMA_VERSION);
  assert.equal(health.overall, doc.overall);
  assert.equal(health.generatedAt, '2026-06-28T00:00:00.000Z');
  assert.deepEqual(health.systems, { rpc: STATUS.UP, cdn: STATUS.DEGRADED });
});

test('buildHealth: overall mirrors buildStatus (worst-of) for the same systems', () => {
  const doc = buildStatus({
    generatedAt: 't',
    systems: [
      shapeResult({ id: 'a', name: 'A', status: STATUS.UP, latencyMs: 10, checkedAt: 't' }),
      shapeResult({ id: 'b', name: 'B', status: STATUS.DOWN, latencyMs: 10, checkedAt: 't' }),
    ],
  });
  assert.equal(buildHealth(doc).overall, STATUS.DOWN);
});

test('buildHealth: is a tiny summary — no per-system latency/detail leaks in', () => {
  const doc = buildStatus({
    generatedAt: 't',
    systems: [shapeResult({ id: 'a', name: 'A', status: STATUS.UP, latencyMs: 99, checkedAt: 't', detail: { kind: 'http' } })],
  });
  const health = buildHealth(doc);
  // The systems map is a flat id->status enum, not the full records.
  assert.equal(health.systems.a, STATUS.UP);
  assert.equal(typeof health.systems.a, 'string');
});

// ---------------------------------------------------------------------------
// errorCode — the classifiers attach a STABLE, catalogued machine code (from
// ERROR_CODE) to non-up outcomes, so an agent can branch on the code instead of
// scraping the human `error` prose. These guard the documented enum contract.
// ---------------------------------------------------------------------------
test('classifyHttp: 5xx carries errorCode HTTP_5XX', () => {
  assert.equal(classifyHttp({ status: 503, latencyMs: 80 }).errorCode, ERROR_CODE.HTTP_5XX);
});

test('classifyHttp: 4xx carries errorCode HTTP_4XX', () => {
  assert.equal(classifyHttp({ status: 404, latencyMs: 80 }).errorCode, ERROR_CODE.HTTP_4XX);
});

test('classifyHttp: transport failure carries errorCode TRANSPORT', () => {
  assert.equal(classifyHttp({ error: 'fetch failed' }).errorCode, ERROR_CODE.TRANSPORT);
});

test('classifyHttp: timeout carries errorCode TIMEOUT', () => {
  assert.equal(classifyHttp({ error: 'timeout' }).errorCode, ERROR_CODE.TIMEOUT);
});

test('classifyJsonRpc: a JSON-RPC error object carries errorCode RPC_ERROR', () => {
  const r = classifyJsonRpc({ status: 200, body: { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'x' } }, latencyMs: 90 });
  assert.equal(r.errorCode, ERROR_CODE.RPC_ERROR);
});

test('classifyJsonRpc: a non-jsonrpc 2xx body carries errorCode RPC_MALFORMED', () => {
  assert.equal(classifyJsonRpc({ status: 200, body: { hi: 1 }, latencyMs: 90 }).errorCode, ERROR_CODE.RPC_MALFORMED);
});

test('classifyChainView: not-synced carries errorCode NOT_SYNCED', () => {
  const body = { blockchain_state: { peak: { height: 10 }, sync: { synced: false } } };
  assert.equal(classifyChainView({ status: 200, body, latencyMs: 110 }).errorCode, ERROR_CODE.NOT_SYNCED);
});

test('classifyChainView: missing peak carries errorCode NO_PEAK', () => {
  assert.equal(classifyChainView({ status: 200, body: {}, latencyMs: 110 }).errorCode, ERROR_CODE.NO_PEAK);
});

test('classifyPeakFreshness: a stale (non-advancing) peak carries errorCode STALE_PEAK', () => {
  const r = classifyPeakFreshness({ height: 100, prevHeight: 100, secondsSincePrev: 1800 });
  assert.equal(r.errorCode, ERROR_CODE.STALE_PEAK);
});

test('classify*: a healthy outcome has no errorCode', () => {
  assert.equal(classifyHttp({ status: 200, latencyMs: 80 }).errorCode, undefined);
});

// ---------------------------------------------------------------------------
// appendHistory() — roll the per-system status into a bounded history series.
// History is keyed by system id; each push records {t, status, latencyMs};
// the series is capped at maxPoints (oldest dropped).
// ---------------------------------------------------------------------------
test('appendHistory: starts an empty series and appends', () => {
  const prior = {};
  const next = appendHistory(prior, {
    systems: [shapeResult({ id: 'a', name: 'A', status: STATUS.UP, latencyMs: 10, checkedAt: '2026-06-28T00:00:00.000Z' })],
  });
  assert.equal(next.a.length, 1);
  assert.deepEqual(next.a[0], { t: '2026-06-28T00:00:00.000Z', status: STATUS.UP, latencyMs: 10 });
});

test('appendHistory: caps series at maxPoints, dropping oldest', () => {
  let hist = {};
  for (let i = 0; i < 5; i++) {
    hist = appendHistory(hist, {
      systems: [shapeResult({ id: 'a', name: 'A', status: STATUS.UP, latencyMs: i, checkedAt: `t${i}` })],
    }, { maxPoints: 3 });
  }
  assert.equal(hist.a.length, 3);
  // oldest dropped → first remaining is t2
  assert.equal(hist.a[0].t, 't2');
  assert.equal(hist.a[2].t, 't4');
});

test('appendHistory: does not mutate the prior history object', () => {
  const prior = { a: [{ t: 't0', status: STATUS.UP, latencyMs: 1 }] };
  const snapshot = JSON.stringify(prior);
  appendHistory(prior, {
    systems: [shapeResult({ id: 'a', name: 'A', status: STATUS.DOWN, latencyMs: 2, checkedAt: 't1' })],
  });
  assert.equal(JSON.stringify(prior), snapshot);
});

// ---------------------------------------------------------------------------
// computeUptime() — % of recorded points that were "up" for a system.
// ---------------------------------------------------------------------------
test('computeUptime: all up is 100', () => {
  const series = [
    { t: 't0', status: STATUS.UP, latencyMs: 1 },
    { t: 't1', status: STATUS.UP, latencyMs: 1 },
  ];
  assert.equal(computeUptime(series), 100);
});

test('computeUptime: degraded counts as partial (not full down)', () => {
  // 1 up, 1 degraded, 1 down over 3 → up=1, degraded weighted 0.5 → 50%
  const series = [
    { t: 't0', status: STATUS.UP, latencyMs: 1 },
    { t: 't1', status: STATUS.DEGRADED, latencyMs: 1 },
    { t: 't2', status: STATUS.DOWN, latencyMs: 1 },
  ];
  assert.equal(computeUptime(series), 50);
});

test('computeUptime: empty series is null (unknown)', () => {
  assert.equal(computeUptime([]), null);
});
