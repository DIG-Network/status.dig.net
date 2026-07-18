#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/run-probes.js — the scheduled probe entrypoint.
//
// Runs server-side (GitHub Actions cron, or `npm run probe` locally), so there
// is NO browser CORS in the read path: this process hits each endpoint directly
// with the platform fetch (default TLS verification → a bad cert surfaces as a
// transport error → "down"). It then:
//   1. classifies each outcome via the pure helpers in lib/probe.js,
//   2. synthesizes the Chia-mainnet liveness row from coinset peak freshness,
//   3. writes public/status.json (current snapshot), and
//   4. appends to public/history.json (bounded rolling series).
//
// All branching/classification logic is in lib/probe.js (unit-tested); this
// file is the thin, I/O-only shell around it.
// ---------------------------------------------------------------------------

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect as tlsConnect } from 'node:tls';

import { TARGETS } from '../lib/targets.js';
import {
  STATUS,
  classifyHttp,
  classifyJsonRpc,
  classifyChainView,
  classifyPeakFreshness,
  classifyTls,
  shapeResult,
  buildStatus,
  buildHealth,
  appendHistory,
  buildFeed,
} from '../lib/probe.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PUBLIC = resolve(ROOT, 'public');
const STATUS_PATH = resolve(PUBLIC, 'status.json');
const HISTORY_PATH = resolve(PUBLIC, 'history.json');
const HEALTH_PATH = resolve(PUBLIC, 'health.json');
const FEED_PATH = resolve(PUBLIC, 'feed.xml');

const REQUEST_TIMEOUT_MS = 12000;

/** Time a fetch and normalize transport failures into an outcome the
 *  classifiers understand: { status?, body?, latencyMs, error? }. */
async function timedFetch(url, init = {}) {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, redirect: 'manual' });
    const latencyMs = Date.now() - start;
    let body;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      body = await res.json().catch(() => undefined);
    } else {
      // Drain so the socket can be reused; we only need the status for non-JSON.
      await res.text().catch(() => undefined);
    }
    return { status: res.status, body, latencyMs };
  } catch (err) {
    return {
      error: err && err.name === 'AbortError' ? 'timeout' : String((err && err.message) || err),
      latencyMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probeJsonRpc(t) {
  const outcome = await timedFetch(t.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: t.rpcMethod, params: t.rpcParams || [] }),
  });
  const c = classifyJsonRpc(outcome);
  return shapeResult({
    id: t.id,
    name: t.name,
    category: t.category,
    description: t.description,
    url: t.url,
    status: c.status,
    latencyMs: outcome.latencyMs,
    checkedAt: new Date().toISOString(),
    detail: {
      kind: 'jsonrpc',
      method: t.rpcMethod,
      ...(c.errorCode ? { errorCode: c.errorCode } : {}),
      ...(c.detail || {}),
    },
    error: outcome.error,
  });
}

async function probeHttp(t) {
  // GET, but a HEAD-ish concern: we only classify on the status code + cert.
  let outcome = await timedFetch(t.url, { method: 'GET', headers: { accept: '*/*' } });
  // For sites that 404 a /v1/health but serve a base path, try the altUrl.
  if (t.altUrl && typeof outcome.status === 'number' && outcome.status === 404) {
    const alt = await timedFetch(t.altUrl, { method: 'GET', headers: { accept: '*/*' } });
    if (typeof alt.status === 'number') outcome = alt;
  }
  const c = classifyHttp(outcome, { optional: t.optional });
  const rec = shapeResult({
    id: t.id,
    name: t.name,
    category: t.category,
    description: t.description,
    url: t.url,
    status: c.status,
    latencyMs: outcome.latencyMs,
    checkedAt: new Date().toISOString(),
    detail: {
      kind: 'http',
      httpStatus: outcome.status ?? null,
      ...(c.errorCode ? { errorCode: c.errorCode } : {}),
    },
    error: outcome.error,
  });
  // An optional, possibly-unprovisioned endpoint never drags the overall.
  if (t.optional) rec.excludeFromOverall = true;
  return rec;
}

/** Open a raw TLS connection and resolve a probe outcome the classifier
 *  understands: { connected?, latencyMs, error?, certError? }. Used for non-HTTP
 *  edges (relay.dig.net's NLB TLS listener). Default cert verification is ON
 *  (rejectUnauthorized: true) so an invalid/expired cert surfaces as certError.
 *  SNI is set so the load balancer presents the right *.dig.net cert. */
async function timedTls(host, port) {
  const start = Date.now();
  return new Promise((resolveOutcome) => {
    let settled = false;
    const done = (outcome) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* already closed */
      }
      resolveOutcome({ ...outcome, latencyMs: Date.now() - start });
    };
    const socket = tlsConnect(
      { host, port, servername: host, rejectUnauthorized: true, timeout: REQUEST_TIMEOUT_MS },
      // 'secureConnect' fires only after a successful handshake (incl. cert
      // verification), so reaching here means the TLS edge + cert are valid.
      () => done({ connected: true }),
    );
    socket.once('timeout', () => done({ error: 'timeout' }));
    socket.once('error', (err) => {
      // Node tags cert-validation failures with a `code` starting CERT_ / a few
      // known TLS codes; treat those as certError so they map to TLS_ERROR.
      const code = err && err.code ? String(err.code) : '';
      const certError =
        /CERT|TLS|SSL|ERR_TLS/i.test(code) ||
        /certificate|self.signed|self-signed/i.test(String((err && err.message) || ''));
      done({ error: String((err && err.message) || err), certError });
    });
  });
}

async function probeTls(t) {
  const outcome = await timedTls(t.host, t.port);
  const c = classifyTls(outcome, { optional: t.optional });
  const rec = shapeResult({
    id: t.id,
    name: t.name,
    category: t.category,
    description: t.description,
    url: t.url,
    status: c.status,
    latencyMs: outcome.latencyMs,
    checkedAt: new Date().toISOString(),
    detail: {
      kind: 'tls',
      host: t.host,
      port: t.port,
      ...(c.errorCode ? { errorCode: c.errorCode } : {}),
    },
    error: outcome.error,
  });
  if (t.optional) rec.excludeFromOverall = true;
  return rec;
}

async function probeChainView(t) {
  const outcome = await timedFetch(t.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({}),
  });
  const c = classifyChainView(outcome);
  return {
    record: shapeResult({
      id: t.id,
      name: t.name,
      category: t.category,
      description: t.description,
      url: t.url,
      status: c.status,
      latencyMs: outcome.latencyMs,
      checkedAt: new Date().toISOString(),
      detail: {
        kind: 'chainview',
        peakHeight: c.detail.peakHeight,
        synced: c.detail.synced,
        ...(c.errorCode ? { errorCode: c.errorCode } : {}),
      },
      error: outcome.error,
    }),
    peakHeight: c.detail.peakHeight,
  };
}

/** Read the prior history (best-effort). Returns {} if absent/corrupt. */
async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Find this system's most recent recorded peak height (+ its timestamp) so we
 *  can judge freshness across runs without any external state store. */
function lastPeak(history) {
  const series = history && history.coinset;
  if (!series || !series.length) return { height: null, t: null };
  for (let i = series.length - 1; i >= 0; i--) {
    if (typeof series[i].peakHeight === 'number')
      return { height: series[i].peakHeight, t: series[i].t };
  }
  return { height: null, t: null };
}

async function main() {
  const history = await readJson(HISTORY_PATH, {});

  const systems = [];
  let currentPeak = null;
  const peakTargets = new Map(); // id -> peakHeight, for derived rows

  // Run independent probes concurrently; derived rows are computed after.
  const independent = TARGETS.filter((t) => t.kind !== 'derived-peak');
  const results = await Promise.all(
    independent.map(async (t) => {
      if (t.kind === 'jsonrpc') return { t, record: await probeJsonRpc(t) };
      if (t.kind === 'http') return { t, record: await probeHttp(t) };
      if (t.kind === 'tls') return { t, record: await probeTls(t) };
      if (t.kind === 'chainview') {
        const r = await probeChainView(t);
        return { t, record: r.record, peakHeight: r.peakHeight };
      }
      return {
        t,
        record: shapeResult({
          id: t.id,
          name: t.name,
          category: t.category,
          status: STATUS.DOWN,
          latencyMs: 0,
          checkedAt: new Date().toISOString(),
          error: 'unknown kind',
        }),
      };
    }),
  );

  for (const { t, record, peakHeight } of results) {
    if (typeof peakHeight === 'number') {
      peakTargets.set(t.id, peakHeight);
      if (t.id === 'coinset') currentPeak = peakHeight;
    }
    // Stash peakHeight onto the coinset record's detail for the history file so
    // freshness can be judged on the next run.
    if (typeof peakHeight === 'number') record.peakHeight = peakHeight;
    systems.push(record);
  }

  // Derived Chia-mainnet liveness from peak freshness.
  for (const t of TARGETS.filter((x) => x.kind === 'derived-peak')) {
    const prior = lastPeak(history);
    let secondsSincePrev = null;
    if (prior.t) secondsSincePrev = Math.max(0, (Date.now() - new Date(prior.t).getTime()) / 1000);
    const fresh = classifyPeakFreshness({
      height: currentPeak,
      prevHeight: prior.height,
      secondsSincePrev,
    });
    systems.push(
      shapeResult({
        id: t.id,
        name: t.name,
        category: t.category,
        description: t.description,
        status: typeof currentPeak === 'number' ? fresh.status : STATUS.DOWN,
        latencyMs: 0,
        checkedAt: new Date().toISOString(),
        detail: {
          kind: 'derived',
          peakHeight: currentPeak,
          advancedBy: fresh.detail ? fresh.detail.advanced : null,
          ...(secondsSincePrev != null ? { secondsSincePrev: Math.round(secondsSincePrev) } : {}),
          ...(fresh.errorCode ? { errorCode: fresh.errorCode } : {}),
        },
        error: typeof currentPeak === 'number' ? undefined : 'no coinset peak available',
      }),
    );
  }

  const generatedAt = new Date().toISOString();
  const statusDoc = buildStatus({ generatedAt, systems });

  // Append to history. We persist peakHeight into the coinset history points so
  // the next run can compute freshness.
  const nextHistory = appendHistory(history, statusDoc);
  // Carry the coinset peakHeight onto its newest history point.
  if (typeof currentPeak === 'number' && nextHistory.coinset && nextHistory.coinset.length) {
    nextHistory.coinset[nextHistory.coinset.length - 1].peakHeight = currentPeak;
  }

  // The tiny machine summary for quick agent polling — a flat {id:status} map
  // plus overall/generatedAt, derived from the same doc so the two can't drift.
  const healthDoc = buildHealth(statusDoc);

  // Make each emitted document self-describing by referencing its committed JSON
  // Schema via a `$schema` key (absolute URL, so it resolves off the live site).
  // The lib stays URL-free + pure; the deploy-target URL is injected here.
  const SCHEMA_BASE = 'https://status.dig.net';
  const withSchema = (doc, file) => ({ $schema: `${SCHEMA_BASE}/${file}`, ...doc });

  // Atom feed of status TRANSITIONS (not per-sample) — a subscribable log of
  // incidents/recoveries for feed readers, agents, and monitoring bots.
  const feedXml = buildFeed(nextHistory, statusDoc);

  await mkdir(PUBLIC, { recursive: true });
  await writeFile(
    STATUS_PATH,
    JSON.stringify(withSchema(statusDoc, 'status.schema.json'), null, 2) + '\n',
  );
  await writeFile(HISTORY_PATH, JSON.stringify(nextHistory) + '\n');
  await writeFile(
    HEALTH_PATH,
    JSON.stringify(withSchema(healthDoc, 'health.schema.json'), null, 2) + '\n',
  );
  await writeFile(FEED_PATH, feedXml);

  // Console summary for the CI log.
  const line = systems.map((s) => `${s.id}=${s.status}`).join(' ');
  console.log(`[status.dig.net] overall=${statusDoc.overall} ${line}`);
}

main().catch((err) => {
  console.error('probe run failed:', err);
  process.exit(1);
});
