#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/build.js — assemble the deployable static site into ./dist.
//
// The site is plain static HTML/CSS/JS (no framework build), matching the
// simplicity of dig.net. "Building" is just copying public/ → dist/ so the
// deploy workflow can `aws s3 sync dist …` exactly like dig.net does (which
// renames Next's export output to ./dist). Keeping the same dist/ contract
// means the deploy workflow mirrors dig.net's one-for-one.
//
// IMPORTANT: status.json / history.json are produced by the probe cron and
// committed into public/. The build carries whatever is currently committed so
// the freshly deployed site renders immediately (then the in-page poll picks up
// newer files on subsequent cron commits + deploys).
// ---------------------------------------------------------------------------

import { cp, rm, mkdir, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PUBLIC = resolve(ROOT, 'public');
const DIST = resolve(ROOT, 'dist');

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function main() {
  if (!(await exists(PUBLIC))) throw new Error('public/ not found');
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  await cp(PUBLIC, DIST, { recursive: true });
  console.log(`[build] copied public/ -> dist/`);
}

main().catch((err) => { console.error('build failed:', err); process.exit(1); });
