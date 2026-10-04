'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStateResultSchema,
  validateAgainstStateSchema,
  validateStateResult,
  validateSupportedStateSchema,
} from '../src/state-schema.mjs';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['constraints'],
  properties: {
    constraints: {
      type: 'array',
      maxItems: 2,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['quote', 'source_message_id'],
        properties: {
          quote: { type: 'string', maxLength: 100 },
          source_message_id: { type: 'string' },
        },
      },
    },
  },
};

test('supported state schema accepts the MVP subset', () => {
  const r = validateSupportedStateSchema(SCHEMA);
  assert.equal(r.ok, true);
});

test('unsupported schema keyword is rejected before model call', () => {
  const r = validateSupportedStateSchema({ ...SCHEMA, oneOf: [] });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /unsupported keyword oneOf/);
});

test('root schema must be an object schema', () => {
  const r = validateSupportedStateSchema({ type: 'array', items: { type: 'string' } });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /root must be object/);
});

test('state output validates recursively and rejects extra fields', () => {
  const good = validateAgainstStateSchema({ constraints: [{ quote: 'Не рассматриваю переезд', source_message_id: 'm2' }] }, SCHEMA);
  assert.equal(good.ok, true);

  const bad = validateAgainstStateSchema({ constraints: [{ quote: 'x', source_message_id: 'm2', invented: true }] }, SCHEMA);
  assert.equal(bad.ok, false);
  assert.match(bad.problems.join(' '), /additional property/);
});

test('model answer must be exactly {state}', () => {
  const r = validateStateResult({ state: { constraints: [] }, reason: 'because' }, SCHEMA);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /extra fields/);
});

test('provider result schema wraps caller state schema', () => {
  const result = buildStateResultSchema(SCHEMA);
  assert.deepEqual(result.required, ['state']);
  assert.equal(result.additionalProperties, false);
  assert.equal(result.properties.state, SCHEMA);
});
