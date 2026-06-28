// Contract tests for the published JSON Schemas (public/*.schema.json) against
// the documents the probe runner shapes (buildStatus / buildHealth / a synthetic
// history). These guard the agent-facing machine contract: if the schemas drift
// from what the code emits (or vice-versa), one of these fails. To stay true to
// this zero-dependency project, a small JSON-Schema validator covering exactly
// the keywords the schemas use is embedded here rather than pulling in ajv.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildStatus, buildHealth, appendHistory, shapeResult, STATUS, SCHEMA_VERSION } from '../lib/probe.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(__dirname, '..', 'public');
const loadSchema = (f) => JSON.parse(readFileSync(resolve(PUBLIC, f), 'utf8'));

// --- minimal JSON-Schema (draft-2020-12 subset) validator -------------------
// Supports: type, enum, const, required, properties, additionalProperties
// (boolean OR sub-schema), items, minimum, $ref (local "#/..."), $defs. Returns
// an array of human-readable error strings (empty = valid).
function validate(schema, data, root = schema, path = '$') {
  const errs = [];
  if (schema.$ref) {
    const target = resolveRef(root, schema.$ref);
    return validate(target, data, root, path);
  }
  if (schema.const !== undefined && data !== schema.const) {
    errs.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(data)}`);
  }
  if (schema.enum && !schema.enum.includes(data)) {
    errs.push(`${path}: ${JSON.stringify(data)} not in enum ${JSON.stringify(schema.enum)}`);
  }
  if (schema.type && !typeMatches(schema.type, data)) {
    errs.push(`${path}: expected type ${JSON.stringify(schema.type)}, got ${jsType(data)}`);
    return errs; // type mismatch — skip deeper checks
  }
  if (typeof data === 'number' && schema.minimum !== undefined && data < schema.minimum) {
    errs.push(`${path}: ${data} < minimum ${schema.minimum}`);
  }
  if (jsType(data) === 'object' && (schema.properties || schema.required || schema.additionalProperties !== undefined)) {
    for (const key of schema.required || []) {
      if (!(key in data)) errs.push(`${path}: missing required '${key}'`);
    }
    const props = schema.properties || {};
    for (const [key, val] of Object.entries(data)) {
      if (props[key]) {
        errs.push(...validate(props[key], val, root, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        errs.push(`${path}: unexpected property '${key}'`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        errs.push(...validate(schema.additionalProperties, val, root, `${path}.${key}`));
      }
    }
  }
  if (jsType(data) === 'array' && schema.items) {
    data.forEach((item, i) => errs.push(...validate(schema.items, item, root, `${path}[${i}]`)));
  }
  return errs;
}

function resolveRef(root, ref) {
  const parts = ref.replace(/^#\//, '').split('/');
  let node = root;
  for (const p of parts) node = node[p];
  if (!node) throw new Error(`unresolvable $ref ${ref}`);
  return node;
}
function jsType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v; // string | number | boolean | object
}
function typeMatches(type, v) {
  const types = Array.isArray(type) ? type : [type];
  const t = jsType(v);
  // an integer also satisfies "number"
  return types.some((x) => x === t || (x === 'number' && t === 'integer'));
}

// --- the actual documents the runner shapes ---------------------------------
function sampleSystems() {
  return [
    shapeResult({ id: 'rpc', name: 'rpc.dig.net', category: 'Read path', status: STATUS.UP, latencyMs: 120, checkedAt: '2026-06-28T00:00:00.000Z', detail: { kind: 'jsonrpc', method: 'dig.methods' }, url: 'https://rpc.dig.net/', description: 'RPC' }),
    { ...shapeResult({ id: 'cdn', name: 'cdn.dig.net', category: 'Read path', status: STATUS.DEGRADED, latencyMs: 9000, checkedAt: '2026-06-28T00:00:00.000Z', detail: { kind: 'http', httpStatus: null, errorCode: 'TRANSPORT' }, error: 'fetch failed' }), excludeFromOverall: true },
    shapeResult({ id: 'coinset', name: 'coinset.org ChainView', category: 'Chia', status: STATUS.UP, latencyMs: 200, checkedAt: '2026-06-28T00:00:00.000Z', detail: { kind: 'chainview', peakHeight: 8933589, synced: true } }),
    shapeResult({ id: 'chia-mainnet', name: 'Chia mainnet', category: 'Chia', status: STATUS.UP, latencyMs: 0, checkedAt: '2026-06-28T00:00:00.000Z', detail: { kind: 'derived', peakHeight: 8933589, advancedBy: 5, secondsSincePrev: 90 } }),
  ];
}

test('status.schema.json: a buildStatus document validates', () => {
  const schema = loadSchema('status.schema.json');
  const doc = buildStatus({ generatedAt: '2026-06-28T00:00:00.000Z', systems: sampleSystems() });
  const errs = validate(schema, doc);
  assert.deepEqual(errs, [], errs.join('\n'));
});

test('status.schema.json: a document WITH the injected $schema key still validates', () => {
  const schema = loadSchema('status.schema.json');
  const doc = { $schema: 'https://status.dig.net/status.schema.json', ...buildStatus({ generatedAt: '2026-06-28T00:00:00.000Z', systems: sampleSystems() }) };
  assert.deepEqual(validate(schema, doc), []);
});

test('status.schema.json: pins schemaVersion to SCHEMA_VERSION', () => {
  const schema = loadSchema('status.schema.json');
  assert.equal(schema.properties.schemaVersion.const, SCHEMA_VERSION);
});

test('health.schema.json: a buildHealth document validates', () => {
  const schema = loadSchema('health.schema.json');
  const doc = buildHealth(buildStatus({ generatedAt: '2026-06-28T00:00:00.000Z', systems: sampleSystems() }));
  assert.deepEqual(validate(schema, doc), []);
});

test('health.schema.json: a document WITH the injected $schema key still validates', () => {
  const schema = loadSchema('health.schema.json');
  const doc = { $schema: 'https://status.dig.net/health.schema.json', ...buildHealth(buildStatus({ generatedAt: 't', systems: sampleSystems() })) };
  assert.deepEqual(validate(schema, doc), []);
});

test('history.schema.json: an appendHistory document validates', () => {
  const schema = loadSchema('history.schema.json');
  const doc = buildStatus({ generatedAt: '2026-06-28T00:00:00.000Z', systems: sampleSystems() });
  let history = appendHistory({}, doc);
  // simulate the runner stamping peakHeight onto the coinset point
  history.coinset[history.coinset.length - 1].peakHeight = 8933589;
  assert.deepEqual(validate(schema, history), []);
});

test('schemas: reject an out-of-enum status (validator + schema actually bite)', () => {
  const schema = loadSchema('health.schema.json');
  const bad = { schemaVersion: SCHEMA_VERSION, overall: 'sideways', generatedAt: 't', systems: { rpc: 'up' } };
  assert.ok(validate(schema, bad).length > 0);
});

test('schemas: all three are valid JSON with the expected $id', () => {
  assert.equal(loadSchema('status.schema.json').$id, 'https://status.dig.net/status.schema.json');
  assert.equal(loadSchema('health.schema.json').$id, 'https://status.dig.net/health.schema.json');
  assert.equal(loadSchema('history.schema.json').$id, 'https://status.dig.net/history.schema.json');
});
