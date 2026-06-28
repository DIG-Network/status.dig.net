#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/serve.js — zero-dependency static file server for local preview.
//
// Serves ./public on http://localhost:PORT (default 4173). Use after
// `npm run probe` so status.json/history.json exist:
//   npm run probe && npm run serve
// ---------------------------------------------------------------------------

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 4173;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';
    // Prevent path traversal: resolve under PUBLIC and verify containment.
    const filePath = normalize(join(PUBLIC, urlPath));
    if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
    const s = await stat(filePath).catch(() => null);
    if (!s || !s.isFile()) { res.writeHead(404); return res.end('not found'); }
    const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': TYPES[extname(filePath)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch (err) {
    res.writeHead(500);
    res.end('server error');
  }
});

server.listen(PORT, () => console.log(`[serve] http://localhost:${PORT}  (serving public/)`));
