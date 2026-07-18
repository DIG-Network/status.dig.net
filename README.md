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

| System                    | Probe                                                      | Why it matters                                                   |
| ------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------- |
| **rpc.dig.net**           | JSON-RPC 2.0 `dig.methods`                                 | The blind content read service every client uses                 |
| **hub.dig.net /v1**       | HTTP `GET /v1/health` (2xx + cert)                         | DIGHUb REST control plane (account/store/domain lifecycle)       |
| **docs.dig.net**          | HTTP 200 + cert                                            | Documentation site                                               |
| **explore.dig.net**       | HTTP 200 + cert                                            | Curated DIG Network dApp store                                   |
| **dig.net**               | HTTP 200 + cert                                            | Marketing / entry-point site                                     |
| **cdn.dig.net**           | HTTP reachable + cert (optional)                           | §21 encrypted-chunk CDN host front                               |
| **apt.dig.net**           | HTTP reachable + cert (optional)                           | Ubuntu/Debian APT repository (`apt install` the DIG ecosystem)   |
| **\*.on.dig.net**         | HTTP 200 + cert (live subdomain)                           | Subdomain resolver serving published store content per subdomain |
| **api.bugreport.dig.net** | HTTP `GET /v1/health` (2xx + cert)                         | Bug-report intake API every DIG frontend embeds                  |
| **relay.dig.net**         | TLS handshake + cert (`wss://relay.dig.net:443`, optional) | NAT-traversal relay DIG nodes connect through                    |
| **coinset.org ChainView** | `get_blockchain_state` (peak height + sync)                | Chia mainnet RPC — the chain trust root                          |
| **Chia mainnet**          | derived from coinset peak freshness                        | Is the chain (and our view of it) advancing?                     |

Each system shows **up / degraded / down**, **latency**, **last-checked**, a
30-point **history sparkline**, and **uptime %** over the recorded window.

## Machine-readable surface (agent-friendly)

The dashboard is rendered client-side; **agents should read the JSON directly**
rather than scraping the HTML. Every public document is committed by the probe
cron, served with `no-cache`, and described by a committed, versioned JSON Schema.

| Path                                   | What                                                                                                                       | Schema                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| [`/health.json`](public/health.json)   | Tiny summary for quick polling: `{schemaVersion, overall, generatedAt, systems:{id:status}}`                               | [`/health.schema.json`](public/health.schema.json)   |
| [`/status.json`](public/status.json)   | Full snapshot: overall, summary counts, per-system records (status, latency, detail, `errorCode`)                          | [`/status.schema.json`](public/status.schema.json)   |
| [`/history.json`](public/history.json) | Rolling per-system history series (keyed by id)                                                                            | [`/history.schema.json`](public/history.schema.json) |
| [`/feed.xml`](public/feed.xml)         | Atom feed of status TRANSITIONS (one entry per state change, not per sample) — subscribe instead of polling `history.json` | —                                                    |
| [`/llms.txt`](public/llms.txt)         | Machine entry point pointing at all of the above + the contract                                                            | —                                                    |
| [`/sitemap.xml`](public/sitemap.xml)   | Standard XML sitemap (one public page)                                                                                     | —                                                    |
| [`/robots.txt`](public/robots.txt)     | Crawl policy — full indexing allowed, points at `sitemap.xml`                                                              | —                                                    |

The **normative contract** for all of the above — the `schemaVersion` rules, the
stable status + failure-code enums, the per-family classification rules, the
uptime scoring, and the DOM hooks — lives in [`SPEC.md`](SPEC.md). Consumers and
reimplementers should build against `SPEC.md`; the classification rules are
unit-tested in [`tests/probe.test.js`](tests/probe.test.js) and the
schema/contract conformance in [`tests/schema.test.js`](tests/schema.test.js).

In brief: each document carries a `$schema` key (self-describing); the stable
status enum is `up` · `degraded` · `down`; `overall` is the worst-of across
systems not marked `excludeFromOverall`; and consumers branch on the machine
`detail.errorCode`, not the human `error` string.

## Architecture

```
GitHub Actions cron (every 5 min)
  └─ node scripts/run-probes.js     (server-side: fetch each endpoint)
       └─ lib/probe.js              (pure classify + shape + history roll + feed)
            ├─ public/status.json   (current snapshot, committed)
            ├─ public/history.json  (rolling per-system series, committed)
            ├─ public/health.json   (tiny {id:status} summary, committed)
            └─ public/feed.xml      (Atom feed of status transitions, committed)
                 ▲
static site (public/) fetches them ──┘  → renders dashboard (app.js)
  └─ scripts/build.js: public/ → dist/  → deploy.yml: S3 sync + CloudFront
```

The committed JSON Schemas (`public/*.schema.json`), `public/llms.txt`,
`public/sitemap.xml`, and `public/robots.txt` are static contracts that ride
the normal build → deploy path.

````

- **`lib/probe.js`** — pure, I/O-free probe/health-classification + status.json
  shaping + history rolling + uptime + Atom-feed projection. This is the tested
  core.
- **`scripts/run-probes.js`** — the cron entrypoint; the only place with
  networking. Maps each target to its classifier and writes `status.json`,
  `history.json`, `health.json`, and `feed.xml` (stamping the JSON docs with a
  `$schema` reference).
- **`public/`** — the static dashboard (`index.html`, `styles.css`, `app.js`) +
  the committed `status.json` / `history.json` / `health.json` / `feed.xml`,
  the JSON Schemas (`*.schema.json`), `llms.txt`, `sitemap.xml`, and
  `robots.txt`.
- **Branding** — clean white product theme using the canonical DIG palette
  (violet `#5800D6` → magenta `#FF00DE`, Space Grotesk / Space Mono), consistent
  with dig.net and the hub.

## Run locally

```bash
npm test            # unit tests (node --test) — probe logic + schema conformance
                    #   + frontend-baseline contracts (llms.txt / sitemap.xml /
                    #   robots.txt existence + per-page SEO tags)
npm run test:a11y   # WCAG 2.2 AA audit (axe-core over the built dashboard at
                    #   desktop + mobile) — runs `npm run build` output via
                    #   scripts/serve-dist.mjs; needs `npx playwright install chromium`
npm run probe       # probe live endpoints -> public/{status,history,health}.json
npm run serve       # static server on http://localhost:4173 (serves public/)
# one-liner:
npm run probe && npm run serve
````

`npm run build` copies `public/` → `dist/` (the deploy artifact).

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on push + PR to
`main` (skipped on the probe cron's `[skip ci]` refresh commits):

- **unit** — `node --test`: probe classification, schema/contract conformance,
  and the frontend-baseline contracts (that `llms.txt`, `sitemap.xml`,
  `robots.txt`, and the per-page SEO/OG/JSON-LD tags exist and are well-formed —
  so a machine entry point or SEO tag can never silently go missing/stale).
- **a11y** — the axe-core **WCAG 2.2 AA** audit over the built, hydrated
  dashboard at desktop + mobile viewports, asserting **zero violations**, plus
  keyboard/skip-link + ARIA-landmark checks.

## Deploy

The site is **live at https://status.dig.net**. Deploy mirrors `dig.net`'s
pattern: **build → S3 sync → CloudFront invalidate**, via
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), triggered on push
to `main` (the probe cron's commits trigger it too, so the live site refreshes
automatically). The probe-generated docs (`status.json` / `history.json` /
`health.json`) are re-put with `no-cache` so they are never served stale; the
static contracts (`*.schema.json`, `llms.txt`, `sitemap.xml`, `robots.txt`)
ride the normal-cache sync. `feed.xml` is also probe-generated (a new entry
lands on every state transition) but rides the normal-cache sync since feed
readers tolerate a short cache delay and CloudFront invalidation on every
deploy already refreshes it.

It deploys to **S3 `status-dig-net`** behind **CloudFront `E3GQZ6ABW10CUL`**
(`status.dig.net`). The bucket, distribution, and OIDC deploy role are read from
repo **Variables** so the workflow stays portable:

| Var                                 | Value                   | Purpose                                   |
| ----------------------------------- | ----------------------- | ----------------------------------------- |
| `STATUS_S3_BUCKET`                  | `status-dig-net`        | S3 website bucket                         |
| `STATUS_CLOUDFRONT_DISTRIBUTION_ID` | `E3GQZ6ABW10CUL`        | CloudFront distribution                   |
| `CI_DEPLOY_ROLE_ARN`                | `arn:aws:iam::…:role/…` | OIDC deploy role (same scheme as dig.net) |

If any of the three is unset, the deploy job **builds + verifies and then skips
the S3 sync** with a clear notice (a safety net should the vars be cleared), so
it stays green regardless.
