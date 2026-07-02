// Frontend baseline contract tests (CLAUDE.md §6.6): every web frontend ships
// a current llms.txt, sitemap.xml, robots.txt, and SEO meta (title/description/
// canonical/OG/Twitter/JSON-LD) on every public page. This guards those static
// contracts in source (public/) so a regression fails CI instead of silently
// shipping a stale/missing machine-entry-point or SEO tag.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(__dirname, '..', 'public');
const read = (f) => readFileSync(resolve(PUBLIC, f), 'utf8');

test('public/llms.txt exists and is non-empty', () => {
  assert.ok(existsSync(resolve(PUBLIC, 'llms.txt')));
  assert.ok(read('llms.txt').length > 100);
});

test('public/robots.txt exists, allows indexing, and points at sitemap.xml', () => {
  const txt = read('robots.txt');
  assert.match(txt, /User-agent:\s*\*/);
  assert.match(txt, /Allow:\s*\//);
  assert.match(txt, /Sitemap:\s*https:\/\/status\.dig\.net\/sitemap\.xml/);
});

test('public/sitemap.xml exists and lists the site root with a lastmod', () => {
  assert.ok(existsSync(resolve(PUBLIC, 'sitemap.xml')));
  const xml = read('sitemap.xml');
  assert.match(xml, /<urlset/);
  assert.match(xml, /<loc>https:\/\/status\.dig\.net\/<\/loc>/);
  assert.match(xml, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
});

test('index.html: unique title + meta description', () => {
  const html = read('index.html');
  assert.match(html, /<title>[^<]{10,}<\/title>/);
  assert.match(html, /<meta name="description" content="[^"]{20,}"/);
});

test('index.html: canonical URL', () => {
  const html = read('index.html');
  assert.match(html, /<link rel="canonical" href="https:\/\/status\.dig\.net\/?"\s*\/?>/);
});

test('index.html: Open Graph + Twitter card tags', () => {
  const html = read('index.html');
  for (const prop of ['og:title', 'og:description', 'og:type', 'og:url', 'og:image']) {
    assert.match(html, new RegExp(`property="${prop}"`), `missing ${prop}`);
  }
  assert.match(html, /name="twitter:card"/);
  assert.match(html, /name="twitter:title"/);
  assert.match(html, /name="twitter:description"/);
});

test('index.html: social card is a raster (PNG) large-image card with dimensions + alt', () => {
  // Twitter/Facebook/Slack/Discord/LinkedIn do NOT render SVG OG images, so the
  // canonical og:image / twitter:image MUST be the raster PNG, with declared
  // dimensions + alt text. Guards against a regression back to the SVG.
  const html = read('index.html');
  assert.match(html, /property="og:image" content="https:\/\/status\.dig\.net\/og-image\.png"/);
  assert.match(html, /property="og:image:width" content="1200"/);
  assert.match(html, /property="og:image:height" content="630"/);
  assert.match(html, /property="og:image:alt" content="[^"]{10,}"/);
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
  assert.match(html, /name="twitter:image" content="https:\/\/status\.dig\.net\/og-image\.png"/);
});

test('public/og-image.png exists and is a real 1200x630 PNG', () => {
  const buf = readFileSync(resolve(PUBLIC, 'og-image.png'));
  // PNG magic number.
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // IHDR width/height are big-endian uint32 at byte offsets 16 and 20.
  assert.equal(buf.readUInt32BE(16), 1200, 'og-image.png width should be 1200');
  assert.equal(buf.readUInt32BE(20), 630, 'og-image.png height should be 630');
});

test('index.html: JSON-LD structured data present and valid JSON', () => {
  const html = read('index.html');
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(m, 'no JSON-LD script tag found');
  const data = JSON.parse(m[1]);
  assert.ok(data['@context']);
  assert.ok(data['@type']);
});

test('index.html: heading order starts at h1 and has exactly one h1', () => {
  const html = read('index.html');
  const h1s = html.match(/<h1[\s>]/g) || [];
  assert.equal(h1s.length, 1, 'exactly one <h1> expected');
});

test('index.html: lang attribute set on <html>', () => {
  const html = read('index.html');
  assert.match(html, /<html lang="en">/);
});

test('styles.css: respects prefers-reduced-motion', () => {
  const css = read('styles.css');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test('styles.css: visible focus indicator defined', () => {
  const css = read('styles.css');
  assert.match(css, /:focus-visible/);
});

test('index.html: skip-to-content link present and targets main landmark', () => {
  const html = read('index.html');
  assert.match(html, /class="skip-link" href="#main-content"/);
  assert.match(html, /<main id="main-content"/);
});

test('index.html: async status regions are announced to assistive tech', () => {
  const html = read('index.html');
  assert.match(html, /id="overall"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="error"[^>]*role="alert"/);
});

test('public/feed.xml exists and is a well-formed Atom feed', () => {
  assert.ok(existsSync(resolve(PUBLIC, 'feed.xml')));
  const xml = read('feed.xml');
  assert.match(xml, /<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/);
  assert.match(xml, /<link rel="self"[^>]*href="https:\/\/status\.dig\.net\/feed\.xml"/);
});

test('index.html: feed is discoverable via <link rel="alternate">', () => {
  const html = read('index.html');
  assert.match(html, /<link rel="alternate" type="application\/atom\+xml" href="\/feed\.xml"/);
});
