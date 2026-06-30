// ---------------------------------------------------------------------------
// status.dig.net — pure probe / health-classification + status.json shaping.
//
// This module is deliberately I/O-FREE. Every export takes plain data (a
// fetch-result-shaped object, a timestamp, a prior history) and returns plain
// data. All networking lives in scripts/run-probes.js so this — the part with
// real branching logic — is fully unit-testable without a network or clock.
//
// A "probe outcome" passed to the classify* helpers is the normalized result
// of one server-side check:
//   { status?: number, body?: any, latencyMs?: number, error?: string }
// where `status` is the HTTP status code (absent on a transport failure),
// `body` is the parsed JSON body (when applicable), and `error` is set when
// the request never produced a response.
// ---------------------------------------------------------------------------

/**
 * Machine-schema version for the public documents (status.json / history.json /
 * health.json). Bump this ONLY on a breaking change to their shape (a removed/
 * renamed field, a changed enum, an incompatible detail.kind variant). Additive
 * fields do NOT bump it. An agent can branch on `schemaVersion` to detect a
 * contract break, and the committed JSON Schemas (public/*.schema.json) are
 * pinned to this version. Keep in lockstep with the `$id`/`version` in those
 * schema files.
 */
export const SCHEMA_VERSION = 1;

/** The three health states, worst-last. This is the STABLE status enum — these
 *  exact string values are the public contract (status.json `status`/`overall`,
 *  health.json `overall`/`systems.*`, history point `status`). Used as string
 *  values so the static dashboard + any agent can switch on them directly.
 *  - 'up'       — reachable and healthy (within latency budget).
 *  - 'degraded' — reachable but impaired (slow, wrong-but-live response, a
 *                 JSON-RPC error object, not-synced, stale peak, or an
 *                 unreachable OPTIONAL target).
 *  - 'down'     — unreachable or hard-failed (no response / DNS / TLS / 5xx). */
export const STATUS = Object.freeze({
  UP: 'up',
  DEGRADED: 'degraded',
  DOWN: 'down',
});

/**
 * Stable, catalogued probe failure-code enum. The probe runner attaches one of
 * these to `detail.errorCode` when a check is not `up`, so an agent can branch
 * on the machine code instead of string-matching the human `error` prose. These
 * are derived from the classification logic below — never from the message text.
 *  - 'TIMEOUT'      — the request exceeded the probe timeout (AbortError).
 *  - 'TRANSPORT'    — DNS / TLS / connection failure (no HTTP response at all).
 *  - 'HTTP_5XX'     — the endpoint returned a 5xx server error.
 *  - 'HTTP_4XX'     — the endpoint returned a 3xx/4xx (reachable, wrong response).
 *  - 'RPC_ERROR'    — a well-formed JSON-RPC error object (service alive, rejected).
 *  - 'RPC_MALFORMED'— a 2xx body that is not a JSON-RPC 2.0 envelope.
 *  - 'NOT_SYNCED'   — the chain node reports it is not synced.
 *  - 'NO_PEAK'      — no peak height present in the ChainView body.
 *  - 'STALE_PEAK'   — the chain peak has not advanced for far longer than a block.
 *  - 'TLS_ERROR'    — a TLS handshake / certificate-validation failure on a raw
 *                     TLS reachability probe (kind=tls): the host answered but
 *                     the cert is invalid/expired/untrusted, or the handshake
 *                     itself failed.
 */
export const ERROR_CODE = Object.freeze({
  TIMEOUT: 'TIMEOUT',
  TRANSPORT: 'TRANSPORT',
  HTTP_5XX: 'HTTP_5XX',
  HTTP_4XX: 'HTTP_4XX',
  RPC_ERROR: 'RPC_ERROR',
  RPC_MALFORMED: 'RPC_MALFORMED',
  NOT_SYNCED: 'NOT_SYNCED',
  NO_PEAK: 'NO_PEAK',
  STALE_PEAK: 'STALE_PEAK',
  TLS_ERROR: 'TLS_ERROR',
});

/**
 * Map a normalized probe outcome to a stable {@link ERROR_CODE} for a transport
 * (no-HTTP-response) failure: a probe `error` of `'timeout'` → `TIMEOUT`, any
 * other transport error → `TRANSPORT`. Returns `null` when the outcome did
 * produce an HTTP response (the HTTP/RPC classifiers own those codes).
 */
export function transportErrorCode(outcome) {
  if (!outcome || typeof outcome.status === 'number') return null;
  return outcome.error === 'timeout' ? ERROR_CODE.TIMEOUT : ERROR_CODE.TRANSPORT;
}

// Severity ordering for "worst-of" rollups (higher = worse).
const SEVERITY = { [STATUS.UP]: 0, [STATUS.DEGRADED]: 1, [STATUS.DOWN]: 2 };

// Chia targets ~18.75s per block. We allow generous slack before calling a
// non-advancing peak "stale" so a single slow block (or a probe landing
// between blocks) never trips a false degrade.
const CHIA_BLOCK_SECONDS = 18.75;
const PEAK_STALE_BLOCKS = 20; // ~6.25 min of no advance before "stale"

const DEFAULT_DEGRADED_MS = 3000; // a reachable-but-slow threshold
const DEFAULT_MAX_POINTS = 2880; // ~10 days at one probe / 5 min

/**
 * Core up/degraded/down decision from a generic probe outcome.
 * `ok:false` is always down. An explicit `degraded:true` flag (set by a
 * protocol-aware classifier) forces degraded. Otherwise a reachable check
 * slower than `degradedMs` is degraded; within budget it is up.
 */
export function classify(outcome, { degradedMs = DEFAULT_DEGRADED_MS } = {}) {
  if (!outcome || outcome.ok === false) return STATUS.DOWN;
  if (outcome.degraded) return STATUS.DEGRADED;
  if (typeof outcome.latencyMs === 'number' && outcome.latencyMs > degradedMs) {
    return STATUS.DEGRADED;
  }
  return STATUS.UP;
}

/**
 * HTTP reachability + status-code classifier (used for docs.dig.net, dig.net,
 * cdn.dig.net). 2xx = up, 5xx = down (server error), other reachable codes
 * (3xx/4xx) = degraded (we got a response, but not the healthy one). A missing
 * status (transport/cert/DNS failure) = down.
 *
 * TLS/cert validity is enforced upstream by the probe runner: it uses the
 * platform fetch with default certificate verification, so a bad/expired cert
 * surfaces here as a transport `error` (no `status`) → down.
 *
 * `opts.optional` softens failures for endpoints that may not be provisioned
 * yet (e.g. cdn.dig.net before its DNS exists): an unreachable/5xx optional is
 * "degraded" (unknown) rather than a hard "down", so it never reads as an
 * ecosystem outage. A reachable optional still classifies normally.
 *
 * @returns {{status: string, ok: boolean}}
 */
export function classifyHttp(outcome, opts = {}) {
  const downOrDegraded = opts.optional ? STATUS.DEGRADED : STATUS.DOWN;
  const code = outcome && outcome.status;
  if (typeof code !== 'number') {
    return { status: downOrDegraded, ok: false, errorCode: transportErrorCode(outcome) };
  }
  if (code >= 200 && code < 300) {
    return { status: classify({ ok: true, latencyMs: outcome.latencyMs }, opts), ok: true };
  }
  if (code >= 500) return { status: downOrDegraded, ok: false, errorCode: ERROR_CODE.HTTP_5XX };
  return { status: STATUS.DEGRADED, ok: false, errorCode: ERROR_CODE.HTTP_4XX };
}

/**
 * dig JSON-RPC 2.0 health classifier (rpc.dig.net via a `dig.methods` /
 * `dig.getAnchoredRoot` probe). A well-formed JSON-RPC *result* = up; a
 * JSON-RPC *error* object = degraded (the service answered but rejected the
 * probe — still alive); a non-2xx transport or a body that isn't JSON-RPC at
 * all = down/degraded respectively.
 */
export function classifyJsonRpc(outcome, opts = {}) {
  const code = outcome && outcome.status;
  if (typeof code !== 'number') {
    return { status: STATUS.DOWN, ok: false, errorCode: transportErrorCode(outcome) };
  }
  if (code < 200 || code >= 300) {
    return { status: STATUS.DOWN, ok: false, errorCode: code >= 500 ? ERROR_CODE.HTTP_5XX : ERROR_CODE.HTTP_4XX };
  }
  const body = outcome.body;
  const isJsonRpc = body && typeof body === 'object' && body.jsonrpc === '2.0';
  if (!isJsonRpc) return { status: STATUS.DEGRADED, ok: false, errorCode: ERROR_CODE.RPC_MALFORMED };
  if ('error' in body && body.error) {
    return { status: STATUS.DEGRADED, ok: false, errorCode: ERROR_CODE.RPC_ERROR, detail: { rpcError: body.error } };
  }
  if ('result' in body) {
    return { status: classify({ ok: true, latencyMs: outcome.latencyMs }, opts), ok: true };
  }
  return { status: STATUS.DEGRADED, ok: false, errorCode: ERROR_CODE.RPC_MALFORMED };
}

/**
 * coinset.org ChainView / get_blockchain_state classifier. Extracts the peak
 * height and sync flag. Reachable + has a peak + synced = up; reachable but the
 * node reports not-synced = degraded; no peak in the body = down.
 *
 * @returns {{status:string, ok:boolean, detail:{peakHeight:(number|null), synced:(boolean|null)}}}
 */
export function classifyChainView(outcome, opts = {}) {
  const code = outcome && outcome.status;
  if (typeof code !== 'number') {
    return { status: STATUS.DOWN, ok: false, errorCode: transportErrorCode(outcome), detail: { peakHeight: null, synced: null } };
  }
  if (code < 200 || code >= 300) {
    return { status: STATUS.DOWN, ok: false, errorCode: code >= 500 ? ERROR_CODE.HTTP_5XX : ERROR_CODE.HTTP_4XX, detail: { peakHeight: null, synced: null } };
  }
  const state = outcome.body && outcome.body.blockchain_state;
  const peakHeight = state && state.peak && typeof state.peak.height === 'number' ? state.peak.height : null;
  if (peakHeight === null) {
    return { status: STATUS.DOWN, ok: false, errorCode: ERROR_CODE.NO_PEAK, detail: { peakHeight: null, synced: null } };
  }
  const synced = state && state.sync ? !!state.sync.synced : null;
  if (synced === false) {
    return { status: STATUS.DEGRADED, ok: false, errorCode: ERROR_CODE.NOT_SYNCED, detail: { peakHeight, synced } };
  }
  return {
    status: classify({ ok: true, latencyMs: outcome.latencyMs }, opts),
    ok: true,
    detail: { peakHeight, synced },
  };
}

/**
 * Raw TLS-handshake reachability classifier (used for relay.dig.net). Some DIG
 * systems are NOT HTTP at their public edge: the relay's public surface is an
 * AWS NLB **TLS listener** fronting the relay WebSocket (`wss://relay.dig.net`),
 * not an HTTP server, so an HTTP GET probe would hit the WebSocket port and
 * misreport. Instead the runner opens a TLS connection and reports the outcome:
 *
 *  - a completed handshake (`connected:true`) = up (latency-budget aware) — this
 *    proves DNS resolved, the load balancer is up, the TLS cert is valid, and an
 *    in-rotation target is being served. Because the NLB only keeps a relay
 *    target in rotation while that target's own `/health` check passes, a live
 *    TLS edge transitively confirms the relay's (internal-only) `/health` is OK.
 *  - a certificate-validation failure (`certError:true`) = down + `TLS_ERROR`.
 *  - any other connect/handshake failure = down + `TIMEOUT`/`TRANSPORT`.
 *
 * `opts.optional` softens an unreachable target to `degraded` (excluded from the
 * overall rollup), matching {@link classifyHttp}'s optional semantics.
 *
 * The probe outcome shape here is `{ connected?: boolean, latencyMs?: number,
 * error?: string, certError?: boolean }` — produced by the I/O shell in
 * scripts/run-probes.js; this classifier stays pure.
 */
export function classifyTls(outcome, opts = {}) {
  const downOrDegraded = opts.optional ? STATUS.DEGRADED : STATUS.DOWN;
  if (outcome && outcome.connected) {
    return { status: classify({ ok: true, latencyMs: outcome.latencyMs }, opts), ok: true };
  }
  let errorCode;
  if (outcome && outcome.certError) errorCode = ERROR_CODE.TLS_ERROR;
  else if (outcome && outcome.error === 'timeout') errorCode = ERROR_CODE.TIMEOUT;
  else errorCode = ERROR_CODE.TRANSPORT;
  return { status: downOrDegraded, ok: false, errorCode };
}

/**
 * Chia mainnet liveness from peak freshness: did the coinset peak advance since
 * the previous probe? On the first run (no prior height) we treat a present
 * height as up. If the height has not advanced and far more than a block's
 * worth of wall-clock time has elapsed, the chain (or our view of it) is stale
 * → degraded. A brief no-advance within a few blocks is normal → up.
 */
export function classifyPeakFreshness({ height, prevHeight, secondsSincePrev }) {
  if (typeof height !== 'number') return { status: STATUS.DOWN, ok: false };
  if (prevHeight == null || secondsSincePrev == null) {
    return { status: STATUS.UP, ok: true, detail: { advanced: null } };
  }
  if (height > prevHeight) {
    return { status: STATUS.UP, ok: true, detail: { advanced: height - prevHeight } };
  }
  // No advance: tolerate up to PEAK_STALE_BLOCKS worth of time before flagging.
  const staleAfter = CHIA_BLOCK_SECONDS * PEAK_STALE_BLOCKS;
  if (secondsSincePrev > staleAfter) {
    return { status: STATUS.DEGRADED, ok: false, errorCode: ERROR_CODE.STALE_PEAK, detail: { advanced: 0, secondsSincePrev } };
  }
  return { status: STATUS.UP, ok: true, detail: { advanced: 0 } };
}

/**
 * Normalize one per-system check into a status.json record. Latency is clamped
 * to a non-negative integer so a clock skew can never emit a negative number to
 * the dashboard.
 */
export function shapeResult({ id, name, category, status, latencyMs, checkedAt, detail, url, error, description }) {
  const rec = {
    id,
    name,
    category: category || null,
    status,
    latencyMs: Math.max(0, Math.round(latencyMs || 0)),
    checkedAt,
  };
  if (description) rec.description = description;
  if (url) rec.url = url;
  if (detail && Object.keys(detail).length) rec.detail = detail;
  if (error) rec.error = String(error);
  return rec;
}

/**
 * Assemble the top-level status.json document. `overall` is the worst-of the
 * component statuses; `summary` counts each state. A system carrying
 * `excludeFromOverall:true` (e.g. an optional, not-yet-provisioned endpoint) is
 * still counted in `summary` and shown to users, but does NOT influence
 * `overall` — so a missing optional dependency never reads as a whole-ecosystem
 * outage.
 */
export function buildStatus({ generatedAt, systems }) {
  const summary = { up: 0, degraded: 0, down: 0, total: systems.length };
  let overall = STATUS.UP;
  for (const s of systems) {
    if (s.status === STATUS.UP) summary.up++;
    else if (s.status === STATUS.DEGRADED) summary.degraded++;
    else if (s.status === STATUS.DOWN) summary.down++;
    if (!s.excludeFromOverall && SEVERITY[s.status] > SEVERITY[overall]) overall = s.status;
  }
  // `schemaVersion` is emitted FIRST so the contract version is the first thing
  // a streaming/partial reader sees; the committed JSON Schema pins this value.
  return { schemaVersion: SCHEMA_VERSION, generatedAt, overall, summary, systems };
}

/**
 * Derive the tiny machine summary (health.json) from a full status doc. This is
 * the cheapest agent-polling surface: a single small object an automated client
 * can fetch to learn the overall rollup and a flat per-system `{id: status}`
 * map, WITHOUT downloading the full status.json (latency/detail/history). It is
 * a pure projection of `buildStatus`'s output — `overall`/`generatedAt` are
 * carried verbatim so the two documents can never disagree.
 *
 * Shape: `{ schemaVersion, overall, generatedAt, systems: { <id>: <status> } }`.
 */
export function buildHealth(statusDoc) {
  const systems = {};
  for (const s of statusDoc.systems) systems[s.id] = s.status;
  return {
    schemaVersion: SCHEMA_VERSION,
    overall: statusDoc.overall,
    generatedAt: statusDoc.generatedAt,
    systems,
  };
}

/**
 * Roll the latest status doc into a bounded, per-system history series. Returns
 * a NEW object (does not mutate `prior`). Each series is capped at `maxPoints`,
 * dropping the oldest points.
 */
export function appendHistory(prior, statusDoc, { maxPoints = DEFAULT_MAX_POINTS } = {}) {
  const next = {};
  // Deep-ish copy of existing series (arrays of plain point objects).
  for (const id of Object.keys(prior || {})) {
    next[id] = prior[id].slice();
  }
  for (const s of statusDoc.systems) {
    const series = next[s.id] ? next[s.id].slice() : [];
    series.push({ t: s.checkedAt, status: s.status, latencyMs: s.latencyMs });
    if (series.length > maxPoints) series.splice(0, series.length - maxPoints);
    next[s.id] = series;
  }
  return next;
}

/**
 * Uptime % over a history series. `up` counts full, `degraded` counts as a half
 * (reachable but impaired), `down` counts as zero. Empty series → null
 * (unknown). Rounded to one decimal place.
 */
export function computeUptime(series) {
  if (!series || series.length === 0) return null;
  let score = 0;
  for (const p of series) {
    if (p.status === STATUS.UP) score += 1;
    else if (p.status === STATUS.DEGRADED) score += 0.5;
  }
  return Math.round((score / series.length) * 1000) / 10;
}
