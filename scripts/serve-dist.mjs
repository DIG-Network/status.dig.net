// Minimal, dependency-free static file server for ./dist — used by
// playwright.config.mjs's `webServer` so the a11y Playwright suite
// (tests/e2e/*.spec.mjs) exercises the EXACT static export a real host serves,
// without pulling in an extra npm package just to run tests. Mirrors
// dig.net/scripts/serve-dist.mjs one-for-one so the two sites' a11y harnesses
// stay consistent.
//
// The dashboard's app.js fetches ./status.json + ./history.json at runtime; the
// build (scripts/build.js) copies the committed public/*.json into dist/, so
// the served page renders the real rows (not just the loading shell) and axe
// audits the actual content DOM.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist');
const port = Number(process.env.PORT) || 4321;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function resolveFile(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const candidates = [
    join(root, decoded),
    join(root, decoded, 'index.html'),
    decoded.endsWith('/') ? null : join(root, decoded + '.html'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const s = await stat(candidate);
      if (s.isFile()) return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
}

const server = createServer(async (req, res) => {
  const file = (await resolveFile(req.url || '/')) || join(root, 'index.html');
  try {
    const body = await readFile(file);
    const type = MIME[extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Serving ./dist at http://127.0.0.1:${port}`);
});
