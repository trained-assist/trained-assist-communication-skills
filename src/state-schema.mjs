'use strict';

export const STATE_RESULT_FIELDS = Object.freeze(['state']);

const SUPPORTED_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const SUPPORTED_KEYS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'description',
]);

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function pathJoin(path, key) {
  return path ? `${path}.${key}` : key;
}

function typeList(type) {
  return Array.isArray(type) ? type : [type];
}

export function buildStateResultSchema(stateSchema) {
  return {
    type: 'object',
    additionalProperties: false,
    required: [...STATE_RESULT_FIELDS],
    properties: {
      state: stateSchema,
    },
  };
}

export function validateSupportedStateSchema(schema) {
  const problems = [];

  function visit(node, path) {
    if (!isPlainObject(node)) {
      problems.push(`${path}: schema node must be an object`);
      return;
    }
    for (const key of Object.keys(node)) {
      if (!SUPPORTED_KEYS.has(key)) problems.push(`${path}: unsupported keyword ${key}`);
    }
    const types = typeList(node.type);
    if (!types.length || types.some((t) => !SUPPORTED_TYPES.has(t))) {
      problems.push(`${path}.type: expected one of ${[...SUPPORTED_TYPES].join('|')}`);
      return;
    }
    if (path === 'state_schema' && !types.includes('object')) {
      problems.push('state_schema.type: root must be object');
    }
    if (node.additionalProperties !== undefined && node.additionalProperties !== false) {
      problems.push(`${path}.additionalProperties: only false is supported`);
    }
    if (node.required !== undefined) {
      if (!Array.isArray(node.required) || node.required.some((v) => typeof v !== 'string' || !v.trim())) {
        problems.push(`${path}.required: expected array of non-empty strings`);
      }
    }
    if (node.properties !== undefined) {
      if (!isPlainObject(node.properties)) {
        problems.push(`${path}.properties: expected object`);
      } else {
        for (const [name, child] of Object.entries(node.properties)) visit(child, pathJoin(pathJoin(path, 'properties'), name));
      }
    }
    if (node.items !== undefined) visit(node.items, pathJoin(path, 'items'));
    for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
      if (node[key] !== undefined && (!Number.isInteger(node[key]) || node[key] < 0)) problems.push(`${path}.${key}: expected non-negative integer`);
    }
    for (const key of ['minimum', 'maximum']) {
      if (node[key] !== undefined && typeof node[key] !== 'number') problems.push(`${path}.${key}: expected number`);
    }
    if (node.enum !== undefined && (!Array.isArray(node.enum) || !node.enum.length)) {
      problems.push(`${path}.enum: expected non-empty array`);
    }
  }

  visit(schema, 'state_schema');
  return { ok: problems.length === 0, problems };
}

function valueTypeOk(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isPlainObject(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function enumHas(values, value) {
  return values.some((v) => Object.is(v, value));
}

export function validateAgainstStateSchema(value, schema, path = 'state') {
  const problems = [];

  function visit(v, s, p) {
    const types = typeList(s.type);
    if (!types.some((t) => valueTypeOk(v, t))) {
      problems.push(`${p}: expected ${types.join('|')}`);
      return;
    }
    if (s.enum && !enumHas(s.enum, v)) problems.push(`${p}: value is not in enum`);

    if (typeof v === 'string') {
      if (Number.isInteger(s.minLength) && v.length < s.minLength) problems.push(`${p}: length < ${s.minLength}`);
      if (Number.isInteger(s.maxLength) && v.length > s.maxLength) problems.push(`${p}: length > ${s.maxLength}`);
    }
    if (typeof v === 'number') {
      if (typeof s.minimum === 'number' && v < s.minimum) problems.push(`${p}: value < ${s.minimum}`);
      if (typeof s.maximum === 'number' && v > s.maximum) problems.push(`${p}: value > ${s.maximum}`);
    }
    if (Array.isArray(v)) {
      if (Number.isInteger(s.minItems) && v.length < s.minItems) problems.push(`${p}: items < ${s.minItems}`);
      if (Number.isInteger(s.maxItems) && v.length > s.maxItems) problems.push(`${p}: items > ${s.maxItems}`);
      if (s.items) v.forEach((item, i) => visit(item, s.items, `${p}[${i}]`));
    }
    if (isPlainObject(v)) {
      const props = isPlainObject(s.properties) ? s.properties : {};
      const required = Array.isArray(s.required) ? s.required : [];
      for (const name of required) {
        if (!Object.hasOwn(v, name)) problems.push(`${p}.${name}: required`);
      }
      if (s.additionalProperties === false) {
        for (const name of Object.keys(v)) {
          if (!Object.hasOwn(props, name)) problems.push(`${p}.${name}: additional property`);
        }
      }
      for (const [name, child] of Object.entries(props)) {
        if (Object.hasOwn(v, name)) visit(v[name], child, `${p}.${name}`);
      }
    }
  }

  visit(value, schema, path);
  return { ok: problems.length === 0, problems };
}

export function validateStateResult(raw, stateSchema) {
  if (!isPlainObject(raw)) return { ok: false, problems: [`answer is not a JSON object: ${Array.isArray(raw) ? 'array' : typeof raw}`] };
  const keys = Object.keys(raw);
  const extra = keys.filter((k) => !STATE_RESULT_FIELDS.includes(k));
  const problems = [];
  if (extra.length) problems.push(`extra fields: ${extra.join(', ')}`);
  if (!Object.hasOwn(raw, 'state')) problems.push('state: required');
  if (!problems.length) {
    const state = validateAgainstStateSchema(raw.state, stateSchema, 'state');
    problems.push(...state.problems);
  }
  return { ok: problems.length === 0, value: problems.length ? undefined : { state: raw.state }, problems };
}
