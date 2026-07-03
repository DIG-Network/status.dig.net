// ---------------------------------------------------------------------------
// The central systems status.dig.net monitors. Each entry is grounded in
// SYSTEM.md ("Systems" + "Interaction map" + "Shared contracts"): these are the
// shared services the whole ecosystem depends on at runtime, not the per-repo
// build artifacts. The probe runner (scripts/run-probes.js) maps each `kind`
// to the matching classifier in lib/probe.js.
//
// `kind` values:
//   'jsonrpc'    — POST a dig JSON-RPC 2.0 method; classifyJsonRpc
//   'http'       — GET, expect 2xx + valid TLS cert; classifyHttp
//   'tls'        — open a raw TLS connection (host:port), expect a valid-cert
//                  handshake; classifyTls. For non-HTTP edges (e.g. the relay's
//                  NLB TLS listener fronting the relay WebSocket).
//   'chainview'  — coinset.org get_blockchain_state; classifyChainView (+ peak
//                  freshness drives the synthetic "Chia mainnet" liveness row)
// ---------------------------------------------------------------------------

export const TARGETS = [
  {
    id: 'rpc',
    name: 'rpc.dig.net',
    category: 'Read path',
    description: 'DIG JSON-RPC read service (blind content retrieval).',
    kind: 'jsonrpc',
    url: 'https://rpc.dig.net/',
    // dig.methods is a cheap, side-effect-free discovery call. If the node does
    // not implement it, classifyJsonRpc returns "degraded" on the JSON-RPC
    // error (the service is alive, just rejected the probe) rather than "down".
    rpcMethod: 'dig.methods',
    rpcParams: [],
  },
  {
    id: 'hub-api',
    name: 'hub.dig.net /v1',
    category: 'Control plane',
    description: 'DIGHUb REST /v1 control plane (account/store/domain lifecycle).',
    kind: 'http',
    // A lightweight reachability probe against the /v1 control-plane root. A
    // 2xx/3xx/4xx all mean the API edge is serving (only 5xx / no-response are
    // failures); see classifyHttp.
    url: 'https://hub.dig.net/v1/health',
    // Fallback path tried if the primary 404s with no JSON — kept here for
    // documentation; the runner probes `url` and classifies the response code.
    altUrl: 'https://hub.dig.net/v1',
  },
  {
    id: 'docs',
    name: 'docs.dig.net',
    category: 'Sites',
    description: 'Docusaurus documentation site (HTTP 200 + cert).',
    kind: 'http',
    url: 'https://docs.dig.net/',
  },
  {
    id: 'explore',
    name: 'explore.dig.net',
    category: 'Sites',
    description: 'Curated DIG Network dApp store (HTTP 200 + cert).',
    kind: 'http',
    url: 'https://explore.dig.net/',
  },
  {
    id: 'dignet',
    name: 'dig.net',
    category: 'Sites',
    description: 'Marketing site (HTTP 200 + cert).',
    kind: 'http',
    url: 'https://dig.net/',
  },
  {
    id: 'cdn',
    name: 'cdn.dig.net',
    category: 'Read path',
    description: '§21 encrypted-chunk CDN (host front).',
    kind: 'http',
    url: 'https://cdn.dig.net/',
    // The CDN may not serve a root document; any reachable response (incl.
    // 403/404) proves the edge + cert are live. Only 5xx / no-response fail.
    optional: true,
  },
  {
    id: 'apt',
    name: 'apt.dig.net',
    category: 'Distribution',
    description: 'Ubuntu/Debian APT repository (apt install the DIG ecosystem).',
    kind: 'http',
    // Reachability + cert of the apt repo edge. Any response (incl. 403/404 on
    // the bare root) proves the edge + cert are live; only 5xx / no-response
    // fail. Marked optional while the apt.dig.net infra is being provisioned, so
    // a not-yet-live repo reads degraded (pending), not a full ecosystem outage.
    url: 'https://apt.dig.net/',
    optional: true,
  },
  {
    id: 'on-resolver',
    name: '*.on.dig.net',
    category: 'Read path',
    description: 'Subdomain resolver — serves published store content per subdomain (branded loader + client-side decrypt).',
    kind: 'http',
    // The resolver answers on a WILDCARD (*.on.dig.net); the apex on.dig.net has
    // no record, so we probe a live subdomain. `chia-offer.on.dig.net` is a real
    // published store that returns 200 with the loader shell — a 2xx proves DNS +
    // the resolver CloudFront dist + cert + the Lambda are all live. Only 5xx /
    // no-response fail (classifyHttp).
    url: 'https://chia-offer.on.dig.net/',
  },
  {
    id: 'bugreport-api',
    name: 'api.bugreport.dig.net',
    category: 'Control plane',
    description: 'Bug-report intake API (auto-report → S3 + GitHub issues) every DIG frontend embeds.',
    kind: 'http',
    // The bug-report service exposes a real health endpoint returning
    // {ok:true,...}. A 2xx proves the APIGW edge + Lambda are serving; any
    // non-5xx response means the edge is up (classifyHttp).
    url: 'https://api.bugreport.dig.net/v1/health',
  },
  {
    id: 'relay',
    name: 'relay.dig.net',
    category: 'Network',
    description: 'NAT-traversal relay (rendezvous + circuit relay) DIG nodes connect through.',
    // The relay's PUBLIC surface is an AWS NLB TLS listener fronting the relay
    // WebSocket (wss://relay.dig.net:443), NOT an HTTP server — an HTTP GET would
    // hit the WebSocket port and misreport. We probe the TLS handshake instead: a
    // valid-cert handshake proves DNS + the load balancer + the cert + an
    // in-rotation target are live. The NLB only keeps a relay target in rotation
    // while that target's own (internal-only, VPC-scoped :9451) /health check
    // passes — which returns {status,connected_peers,uptime_secs,version} — so a
    // live TLS edge transitively confirms the relay's /health is green.
    kind: 'tls',
    host: 'relay.dig.net',
    port: 443,
    url: 'wss://relay.dig.net:443',
    // Marked optional while relay.dig.net is being provisioned (its NLB + Route53
    // record are defined in the superproject's private infra/dig-relay/ but may
    // not be applied yet). An unreachable optional reads "degraded" (pending) and
    // is excluded from the overall rollup, so a not-yet-live relay never shows the
    // whole ecosystem as down. Drop `optional` once relay.dig.net is live.
    optional: true,
  },
  {
    id: 'coinset',
    name: 'coinset.org ChainView',
    category: 'Chia',
    description: 'Chia mainnet RPC (blockchain state / peak height) — the chain trust root.',
    kind: 'chainview',
    url: 'https://api.coinset.org/get_blockchain_state',
  },
  // 'chia-mainnet' is synthesized by the runner from the coinset peak height +
  // the previously-recorded peak (freshness). It has no URL of its own.
  {
    id: 'chia-mainnet',
    name: 'Chia mainnet',
    category: 'Chia',
    description: 'Mainnet liveness — derived from coinset peak-height freshness.',
    kind: 'derived-peak',
    dependsOn: 'coinset',
  },
];
