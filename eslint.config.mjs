// Minimal flat ESLint config for this plain-JS repo (CLAUDE.md §2.4a lint gate).
// Two source shapes: ES-module Node code (lib/ scripts/ tests/) and the classic
// non-module browser script (public/app.js). Each gets the right globals so the
// recommended rules run clean without ceremony.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'dist/**', 'public/*.json', 'public/feed.xml'] },
  js.configs.recommended,
  {
    files: ['lib/**/*.js', 'scripts/**/*.{js,mjs}', 'tests/**/*.{js,mjs}', '*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    // The dashboard renderer is a classic <script> (window/document, no imports).
    files: ['public/app.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.browser },
    },
  },
  {
    // Playwright e2e specs run in Node but embed page.evaluate() callbacks that
    // execute in the browser, so they legitimately reference window/document.
    files: ['tests/e2e/**/*.{js,mjs}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
];
