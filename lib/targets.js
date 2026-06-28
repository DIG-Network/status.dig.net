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
