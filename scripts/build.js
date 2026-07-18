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

import { cp, rm, mkdir, access, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PUBLIC = resolve(ROOT, 'public');
const DIST = resolve(ROOT, 'dist');

// Files carrying the %%APP_VERSION%% build-version placeholder (CLAUDE.md §6.7): the <meta
// app-version> tag + footer display in index.html, and the window.__APP_VERSION__ assignment
// in app.js. Substituted here (not hand-maintained) so it can never drift from package.json.
const VERSION_TEMPLATED_FILES = ['index.html', 'app.js'];
const VERSION_PLACEHOLDER = '%%APP_VERSION%%';

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Read the app's own semver from package.json — the single source of truth for the build version. */
export async function readAppVersion() {
  const pkg = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'));
  return pkg.version;
}

/** Replace every %%APP_VERSION%% occurrence in the given dist file with the real semver. */
export async function injectVersion(distDir, version) {
  for (const rel of VERSION_TEMPLATED_FILES) {
    const p = resolve(distDir, rel);
    const src = await readFile(p, 'utf8');
    await writeFile(p, src.split(VERSION_PLACEHOLDER).join(version), 'utf8');
  }
}

async function main() {
  if (!(await exists(PUBLIC))) throw new Error('public/ not found');
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  await cp(PUBLIC, DIST, { recursive: true });
  console.log(`[build] copied public/ -> dist/`);
  const version = await readAppVersion();
  await injectVersion(DIST, version);
  console.log(`[build] injected app version ${version} into ${VERSION_TEMPLATED_FILES.join(', ')}`);
}

main().catch((err) => {
  console.error('build failed:', err);
  process.exit(1);
});
