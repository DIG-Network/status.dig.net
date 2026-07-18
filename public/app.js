// ---------------------------------------------------------------------------
// status.dig.net — dashboard renderer.
//
// Fetches the server-generated status.json (current snapshot) and history.json
// (rolling per-system series) — both static files committed by the probe cron,
// so there is no live cross-origin probing from the browser. Renders the
// overall banner, summary counts, and a per-system list with a 30-point
// sparkline + uptime %.
// ---------------------------------------------------------------------------
'use strict';

// Build-version exposure (CLAUDE.md §6.7): %%APP_VERSION%% is a build-time token replaced by
// scripts/build.js from package.json (never hand-maintained here). Read by the bug-report widget.
window.__APP_VERSION__ = '%%APP_VERSION%%';

const STATUS_LABEL = { up: 'Operational', degraded: 'Degraded', down: 'Down' };
const SPARK_POINTS = 30;

function $(sel, root) { return (root || document).querySelector(sel); }

function fmtLatency(ms) {
  if (ms == null) return '—';
  if (ms === 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function fmtUptime(pct) {
  if (pct == null) return '—';
  // Show one decimal only when it isn't a whole number, to keep it tidy.
  return Number.isInteger(pct) ? `${pct}%` : `${pct.toFixed(1)}%`;
}

function fmtAgo(iso) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(iso).toLocaleString();
}

// Split a host out of a system name so it can be mono-styled (e.g. "hub.dig.net /v1").
function renderName(el, name) {
  const m = name.match(/^([a-z0-9.-]+\.[a-z]{2,})(.*)$/i);
  if (m) {
    el.innerHTML = `<span class="host"></span><span class="rest"></span>`;
    $('.host', el).textContent = m[1];
    $('.rest', el).textContent = m[2];
  } else {
    el.textContent = name;
  }
}

function sparkline(container, series) {
  container.innerHTML = '';
  const points = (series || []).slice(-SPARK_POINTS);
  if (!points.length) return;
  const max = Math.max(1, ...points.map((p) => p.latencyMs || 0));
  for (const p of points) {
    const bar = document.createElement('div');
    bar.className = `spark-bar s-${p.status}`;
    // Height encodes latency (min 3px), but color encodes status — so a down
    // point is always visible even at zero latency.
    const h = p.status === 'down' ? 26 : Math.max(3, Math.round(((p.latencyMs || 0) / max) * 26));
    bar.style.height = `${h}px`;
    const when = p.t ? new Date(p.t).toLocaleString() : '';
    bar.title = `${STATUS_LABEL[p.status] || p.status}${p.latencyMs ? ` · ${fmtLatency(p.latencyMs)}` : ''}${when ? ` · ${when}` : ''}`;
    container.appendChild(bar);
  }
}

function detailLine(sys) {
  const d = sys.detail || {};
  if (d.kind === 'chainview' && typeof d.peakHeight === 'number') return `peak #${d.peakHeight.toLocaleString()}`;
  if (d.kind === 'derived' && typeof d.peakHeight === 'number') {
    if (d.advancedBy && d.advancedBy > 0) return `+${d.advancedBy} block${d.advancedBy === 1 ? '' : 's'}`;
    return `peak #${d.peakHeight.toLocaleString()}`;
  }
  if (d.kind === 'jsonrpc' && d.method) return d.method;
  if (d.kind === 'http' && d.httpStatus) return `HTTP ${d.httpStatus}`;
  return '';
}

function renderRow(sys, series, uptime) {
  const tpl = $('#row-tpl').content.cloneNode(true);
  const row = $('.row', tpl);
  row.classList.add(`is-${sys.status}`);
  // Stable machine hooks so an agent can select + read each row deterministically
  // (driven from the data, not styling classes or visible text).
  row.setAttribute('data-testid', 'system-row');
  row.setAttribute('data-system-id', sys.id);
  row.setAttribute('data-status', sys.status);
  row.setAttribute('data-latency-ms', String(sys.latencyMs ?? 0));
  if (uptime != null) row.setAttribute('data-uptime', String(uptime));
  if (sys.detail && sys.detail.errorCode) row.setAttribute('data-error-code', sys.detail.errorCode);
  $('.status-word', row).textContent = STATUS_LABEL[sys.status] || sys.status;
  renderName($('.row-name', row), sys.name);

  const dl = detailLine(sys);
  $('.row-desc', row).textContent = sys.description || dl || '';
  if (sys.description && dl) $('.row-desc', row).textContent = `${sys.description}  ·  ${dl}`;

  sparkline($('.row-spark', row), series);
  $('.uptime-val', row).textContent = fmtUptime(uptime);

  const latencyEl = $('.row-latency', row);
  if (sys.status === 'down') {
    latencyEl.textContent = sys.error ? `down · ${sys.error}` : 'down';
  } else {
    latencyEl.textContent = fmtLatency(sys.latencyMs);
  }
  return tpl;
}

function setOverall(doc) {
  const el = $('#overall');
  el.className = `overall is-${doc.overall}`;
  // Machine hooks on the banner: the rollup + when it was generated.
  el.setAttribute('data-overall', doc.overall);
  if (doc.generatedAt) el.setAttribute('data-generated-at', doc.generatedAt);
  const titles = {
    up: 'All systems operational',
    degraded: 'Some systems are degraded',
    down: 'A system outage is in progress',
  };
  $('#overall-title').textContent = titles[doc.overall] || 'System status';
  const s = doc.summary || {};
  $('#overall-sub').textContent =
    `${s.up || 0} of ${s.total || 0} systems operational` +
    (s.degraded ? ` · ${s.degraded} degraded` : '') +
    (s.down ? ` · ${s.down} down` : '');
}

// Byte-identical copy of lib/probe.js#computeUptime (up=1, degraded=0.5, down=0).
// Deliberately duplicated: this file is a classic non-module <script> and lib/ is
// never shipped to the browser, so it cannot be imported here. Keep the two in
// lockstep — tests/uptime-parity.test.js asserts they score identically.
function computeUptime(series) {
  if (!series || !series.length) return null;
  let score = 0;
  for (const p of series) {
    if (p.status === 'up') score += 1;
    else if (p.status === 'degraded') score += 0.5;
  }
  return Math.round((score / series.length) * 1000) / 10;
}

function render(doc, history) {
  setOverall(doc);

  const sumEl = $('#summary');
  sumEl.hidden = false;
  $('#n-up').textContent = doc.summary.up || 0;
  $('#n-degraded').textContent = doc.summary.degraded || 0;
  $('#n-down').textContent = doc.summary.down || 0;

  $('#generated-at').textContent = fmtAgo(doc.generatedAt);
  $('#generated-at').title = doc.generatedAt || '';

  // Group systems by category, preserving first-seen order.
  const groups = new Map();
  for (const sys of doc.systems) {
    const cat = sys.category || 'Other';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(sys);
  }

  const root = $('#systems');
  root.innerHTML = '';
  for (const [cat, list] of groups) {
    const section = document.createElement('div');
    const title = document.createElement('h2');
    title.className = 'group-title';
    title.textContent = cat;
    section.appendChild(title);
    const groupBox = document.createElement('div');
    groupBox.className = 'group';
    for (const sys of list) {
      const series = (history && history[sys.id]) || [];
      groupBox.appendChild(renderRow(sys, series, computeUptime(series)));
    }
    section.appendChild(groupBox);
    root.appendChild(section);
  }
}

function showError(msg) {
  const el = $('#error');
  el.hidden = false;
  el.textContent = msg;
  const overall = $('#overall');
  overall.className = 'overall';
  $('#overall-title').textContent = 'Status unavailable';
  $('#overall-sub').textContent = 'Could not load the latest health check.';
}

async function load() {
  try {
    const bust = `?t=${Date.now()}`;
    const [statusRes, histRes] = await Promise.all([
      fetch(`./status.json${bust}`, { cache: 'no-store' }),
      fetch(`./history.json${bust}`, { cache: 'no-store' }).catch(() => null),
    ]);
    if (!statusRes.ok) throw new Error(`status.json: HTTP ${statusRes.status}`);
    const doc = await statusRes.json();
    let history = {};
    if (histRes && histRes.ok) history = await histRes.json().catch(() => ({}));
    render(doc, history);
  } catch (err) {
    showError(`Could not load status data (${err.message}). The probe may not have run yet.`);
  }
}

load();
// Auto-refresh while the tab is open (the underlying files update on the cron).
setInterval(load, 60000);
