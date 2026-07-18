# status.dig.net — SPEC

Normative contract for the status.dig.net machine-readable surface. This is the
authoritative document an independent reimplementation (a consumer or a second
publisher) can be built against; the README is the friendly overview and links
here. The key words MUST, MUST NOT, SHOULD, and MAY are used per RFC 2119.

status.dig.net is a static site fed by a scheduled server-side probe: a cron
checks every monitored endpoint, classifies each result, and commits a set of
machine-readable JSON documents that the static dashboard renders client-side.
Agents MUST read the committed JSON directly rather than scraping the rendered
HTML.

## 1. Published documents

The publisher MUST commit and serve the following documents at the site root.
Consumers polling for health SHOULD fetch `health.json` first (smallest).

| Path            | Contents                                                                   | Schema                 |
| --------------- | -------------------------------------------------------------------------- | ---------------------- |
| `/health.json`  | Tiny summary: `{schemaVersion, overall, generatedAt, systems:{id:status}}` | `/health.schema.json`  |
| `/status.json`  | Full snapshot: `overall`, per-state `summary` counts, per-system records   | `/status.schema.json`  |
| `/history.json` | Rolling per-system history series, keyed by system id                      | `/history.schema.json` |
| `/feed.xml`     | Atom feed of status TRANSITIONS (one entry per state change)               | —                      |
| `/llms.txt`     | Machine entry point pointing at all of the above + this contract           | —                      |
| `/sitemap.xml`  | XML sitemap (one public page)                                              | —                      |
| `/robots.txt`   | Crawl policy (full indexing allowed, points at `sitemap.xml`)              | —                      |

Each emitted JSON document MUST carry a `$schema` key referencing its schema, so
it is self-describing. `health.json`, `status.json`, and `history.json` MUST be
served with `no-cache` so a consumer never reads a stale snapshot; the static
contracts (`*.schema.json`, `llms.txt`, `sitemap.xml`, `robots.txt`) MAY ride the
normal cache.

## 2. Schema version

- `schemaVersion` (currently `1`) versions the document shape and MUST be emitted
  as the first key of each JSON document.
- It MUST be bumped ONLY on a breaking change to the shape (a removed/renamed
  field, a changed enum, an incompatible `detail.kind` variant). Additive fields
  MUST NOT bump it.
- The committed JSON Schemas MUST stay pinned in lockstep with this value.
- Consumers SHOULD branch on `schemaVersion` to detect a contract break.

## 3. Stable status enum

Every `status`/`overall`/per-history-point `status` field MUST be one of these
exact string values (the STABLE public enum):

- `up` — reachable and healthy (within the latency budget).
- `degraded` — reachable but impaired: slow, a wrong-but-live response, a
  JSON-RPC error object, not-synced, a stale peak, OR an unreachable OPTIONAL
  target.
- `down` — unreachable / hard-failed: no response, DNS, TLS, or 5xx.

`overall` MUST be the worst-of rollup across systems NOT marked
`excludeFromOverall`. An optional, not-yet-provisioned endpoint carries
`excludeFromOverall` and therefore MUST NOT drag `overall` down; it is still
counted in `summary` and shown to users.

## 4. Stable failure-code enum

When a system is not `up`, the publisher MUST attach a machine failure code at
`detail.errorCode` from this stable enum; consumers MUST branch on this code, not
on the human-readable `error` string:

`TIMEOUT`, `TRANSPORT`, `HTTP_5XX`, `HTTP_4XX`, `RPC_ERROR`, `RPC_MALFORMED`,
`NOT_SYNCED`, `NO_PEAK`, `STALE_PEAK`, `TLS_ERROR`.

`detail.kind` discriminates the probe family and MUST be one of: `http`,
`jsonrpc`, `tls`, `chainview`, `derived`.

## 5. Classification rules

The publisher MUST classify each probe outcome as follows (all rules are
unit-tested in `tests/probe.test.js`):

- **HTTP** — 2xx = `up`; 3xx/4xx = `degraded` (reachable, wrong response); 5xx or
  no-response (DNS/TLS/transport) = `down`. A bad/expired cert fails the default
  fetch verification and therefore surfaces as `down`.
- **JSON-RPC** — a JSON-RPC 2.0 `result` = `up`; a JSON-RPC `error` object =
  `degraded` (alive but rejected the probe); a non-2xx transport = `down`; a 2xx
  body that is not a JSON-RPC envelope = `degraded` (`RPC_MALFORMED`).
- **TLS** (raw handshake, e.g. `relay.dig.net`) — a valid-cert handshake = `up`;
  a cert-validation failure = `down` (`TLS_ERROR`); any other connect/handshake
  failure = `down` (`TIMEOUT`/`TRANSPORT`).
- **ChainView** — reachable + a peak height + synced = `up`; the node reports
  not-synced = `degraded` (`NOT_SYNCED`); no peak = `down` (`NO_PEAK`).
- **Peak freshness** (derived) — the peak advanced since the last probe = `up`;
  no advance for far longer than a Chia block (~18.75 s × 20) = `degraded`
  (`STALE_PEAK`).
- **Optional targets** — an unreachable OPTIONAL target reads `degraded` (not
  `down`) and MUST be excluded from the `overall` rollup, so a not-yet-provisioned
  dependency never shows the whole ecosystem as down.

## 6. Uptime

Uptime % over a history series MUST score `up` as `1`, `degraded` as `0.5`, and
`down` as `0`, averaged over the series and rounded to one decimal place; an empty
series yields `null` (unknown). This scoring is implemented once in
`lib/probe.js#computeUptime` and mirrored byte-for-byte in the browser
`public/app.js` (which cannot import the module); the two MUST stay in lockstep
(guarded by `tests/uptime-parity.test.js`).

## 7. Monitored systems

The set of monitored systems is defined ONLY in `lib/targets.js` (the single
source of truth). Every monitored system's stable `id` and display `name` MUST be
documented in both `public/llms.txt` ("Monitored systems") and the README table;
this parity is enforced by `tests/monitored-parity.test.js` so a target can never
go undocumented.

## 8. DOM hooks (rendered dashboard)

For consumers that must drive the rendered page rather than the JSON, the
following stable hooks MUST be present:

- `#overall` carries `data-testid="overall"`, `data-overall`, and
  `data-generated-at`.
- Each system row carries `data-testid="system-row"`, `data-system-id`,
  `data-status`, `data-uptime`, and `data-latency-ms`.

## 9. Publish path (probe cron)

The probe workflow (`.github/workflows/probe.yml`) is a **sanctioned bot-commit
exception** to the branch-protection PR flow: on a 5-minute cron it commits the
refreshed `status.json` / `history.json` / `health.json` / `feed.xml` directly to
`main` as the `dig-status-bot` identity, then dispatches the deploy. This path is
tightly scoped — it stages ONLY those four generated data files (`git add` names
them explicitly, never source) and its commits are marked `[skip ci]` — so it
carries no code and cannot bypass the code-review gates. It is the ONLY sanctioned
direct-to-`main` path for this repo (analogous to the CLAUDE.md §3.6a dig-browser
carve-out); all source changes MUST still go through a PR.
