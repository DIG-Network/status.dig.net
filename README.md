# status.dig.net

Public health & status dashboard for the **DIG Network** — a statuspage-style
view of the central, shared systems the whole ecosystem relies on at runtime.

It is a **static site** fed by a **scheduled server-side probe**: a GitHub
Actions cron hits each endpoint directly (no browser → no live-CORS issues),
classifies the result, and commits a `status.json` (current snapshot) plus a
rolling `history.json` into this repo. The page just fetches those two files.

## What it monitors

The monitored systems are defined in [`lib/targets.js`](lib/targets.js) and are
grounded in the ecosystem dependency map (`SYSTEM.md`):

| System | Probe | Why it matters |
|---|---|---|
| **rpc.dig.net** | JSON-RPC 2.0 `dig.methods` | The blind content read service every client uses |
| **hub.dig.net /v1** | HTTP `GET /v1/health` (2xx + cert) | DIGHUb REST control plane (account/store/domain lifecycle) |
| **docs.dig.net** | HTTP 200 + cert | Documentation site |
| **dig.net** | HTTP 200 + cert | Marketing / entry-point site |
| **cdn.dig.net** | HTTP reachable + cert (optional) | §21 encrypted-chunk CDN host front |
| **coinset.org ChainView** | `get_blockchain_state` (peak height + sync) | Chia mainnet RPC — the chain trust root |
| **Chia mainnet** | derived from coinset peak freshness | Is the chain (and our view of it) advancing? |

Each system shows **up / degraded / down**, **latency**, **last-checked**, a
30-point **history sparkline**, and **uptime %** over the recorded window.

Classification rules (all unit-tested in [`tests/probe.test.js`](tests/probe.test.js)):

- **HTTP**: 2xx = up, 3xx/4xx = degraded (reachable, wrong response), 5xx or
  no-response (DNS/TLS/transport) = down. A bad/expired cert fails the default
  fetch verification → surfaces as down.
- **JSON-RPC**: a `result` = up; a JSON-RPC `error` object = degraded (alive but
  rejected the probe); non-2xx transport = down.
- **ChainView**: reachable + a peak height + synced = up; node reports
  not-synced = degraded; no peak = down.
- **Peak freshness**: peak advanced since the last probe = up; no advance for
  far longer than a Chia block (~18.75s × 20) = degraded (stale).
- **Optional targets** (e.g. `cdn.dig.net` before it is provisioned): an
  unreachable optional reads as **degraded**, not down, and is excluded from the
  overall rollup — a missing optional never shows the whole ecosystem as down.

## Architecture

```
GitHub Actions cron (every 5 min)
  └─ node scripts/run-probes.js     (server-side: fetch each endpoint)
       └─ lib/probe.js              (pure classify + shape + history roll)
            ├─ public/status.json   (current snapshot, committed)
            └─ public/history.json  (rolling per-system series, committed)
                 ▲
static site (public/) fetches both ──┘  → renders dashboard (app.js)
  └─ scripts/build.js: public/ → dist/  → deploy.yml: S3 sync + CloudFront
```

- **`lib/probe.js`** — pure, I/O-free probe/health-classification + status.json
  shaping + history rolling + uptime. This is the tested core.
- **`scripts/run-probes.js`** — the cron entrypoint; the only place with
  networking. Maps each target to its classifier and writes the two JSON files.
- **`public/`** — the static dashboard (`index.html`, `styles.css`, `app.js`) +
  the committed `status.json` / `history.json`.
- **Branding** — clean white product theme using the canonical DIG palette
  (violet `#5800D6` → magenta `#FF00DE`, Space Grotesk / Space Mono), consistent
  with dig.net and the hub.

## Run locally

```bash
npm test            # run the unit tests (node --test)
npm run probe       # probe live endpoints -> public/status.json + history.json
npm run serve       # static server on http://localhost:4173 (serves public/)
# one-liner:
npm run probe && npm run serve
```

`npm run build` copies `public/` → `dist/` (the deploy artifact).

## Deploy

Deploy mirrors `dig.net`'s pattern: **build → S3 sync → CloudFront invalidate**,
via [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), triggered on
push to `main` (the probe cron's commits trigger it too, so the live site
refreshes automatically).

The deploy is **parameterized** because the infra does not exist yet. Set these
repo **Variables** (Settings → Secrets and variables → Actions → Variables):

| Var | Example | Purpose |
|---|---|---|
| `STATUS_S3_BUCKET` | `status-dig-net` | S3 website bucket |
| `STATUS_CLOUDFRONT_DISTRIBUTION_ID` | `EXXXXXXXXXXXXX` | CloudFront distribution |
| `CI_DEPLOY_ROLE_ARN` | `arn:aws:iam::…:role/…` | OIDC deploy role (same scheme as dig.net) |

Until all three are set, the deploy job **builds + verifies and then skips the
S3 sync** with a clear notice, so it stays green pre-provisioning.

### Infra to provision (parent / AWS admin)

`status.dig.net` has **no AWS infra yet**. To go live, provision (mirroring
dig.net):

1. **S3 bucket** `status-dig-net` (static website hosting).
2. **CloudFront distribution** in front of it (default root object `index.html`),
   honoring the short-TTL behavior for `status.json` / `history.json` (the
   deploy re-puts them `no-cache` and invalidates `/*`).
3. **Route53** `status.dig.net` A/AAAA alias → the distribution; ACM cert in
   `us-east-1` for `status.dig.net`.
4. Allow the existing OIDC `CI_DEPLOY_ROLE_ARN` to `s3:*` on the bucket and
   `cloudfront:CreateInvalidation` on the distribution, then set the three repo
   vars above.
