'use strict';

export const GOAL_STATUSES = Object.freeze(['goal_ready', 'wait', 'no_matching_option']);

function executionSchema(materialBindings = null) {
  const variants = [
    { type: 'null' },
    { type: 'object', additionalProperties: false, required: ['type'], properties: { type: { type: 'string', enum: ['write_message'] } } },
  ];
  if (materialBindings === null || materialBindings.length) variants.push({
    type: 'object', additionalProperties: false, required: ['type', 'stage_id'],
    properties: {
      type: { type: 'string', enum: ['send_material'] },
      stage_id: { type: 'string', minLength: 1, ...(materialBindings ? { enum: materialBindings.map(binding => binding.stage_id) } : {}) },
      resend_requested: { type: 'boolean' },
    },
  });
  return { anyOf: variants };
}

export function buildGoalDecisionSchema(materialBindings = null) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['status'],
    properties: {
      status: { type: 'string', enum: [...GOAL_STATUSES] },
      goal: {
        type: ['object', 'null'],
        additionalProperties: false,
        required: ['instruction'],
        properties: {
          instruction: { type: 'string', minLength: 8, description: 'Open-ended next action for the writer, derived from the conversation objective and current state.' },
          required_points: { type: 'array', description: 'Only confirmed factual information to mention, preferably short exact quotes from state evidence. No communicative directives, questions, prohibitions, unknown facts, or planned checks; use [] when unnecessary.', items: { type: 'string' } },
          forbidden_points: { type: 'array', description: 'Prohibitions for the writer. Actions belong in instruction, confirmed facts in required_points.', items: { type: 'string' } },
        },
      },
      ...(materialBindings ? { execution: executionSchema(materialBindings) } : {}),
      reason: { type: 'string', description: 'Optional explanation; may be empty.' },
    },
    // The model-facing shape agrees with the validator: a ready action has a
    // goal, while waiting decisions can only omit it or return null.
    anyOf: [
      { required: ['goal'], properties: { status: { enum: ['goal_ready'] }, goal: { type: 'object' } } },
      { properties: { status: { enum: ['wait', 'no_matching_option'] }, goal: { type: 'null' }, ...(materialBindings ? { execution: { type: 'null' } } : {}) } },
    ],
  };
}

export function validateGoalDecision(raw, materialBindings = null) {
  const problems = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, problems: ['answer must be a JSON object'] };
  for (const key of Object.keys(raw)) if (![ 'status', 'goal', 'reason', ...(materialBindings ? ['execution'] : []) ].includes(key)) problems.push(`unexpected field: ${key}`);
  if (!GOAL_STATUSES.includes(raw.status)) problems.push(`status must be one of: ${GOAL_STATUSES.join(', ')}`);
  if (raw.status === 'goal_ready') {
    if (!raw.goal || typeof raw.goal !== 'object' || Array.isArray(raw.goal)) problems.push('goal is required when status is goal_ready');
    else {
      for (const key of Object.keys(raw.goal)) if (!['instruction', 'required_points', 'forbidden_points'].includes(key)) problems.push(`unexpected goal field: ${key}`);
      if (typeof raw.goal.instruction !== 'string' || raw.goal.instruction.trim().length < 8) problems.push('goal.instruction must contain at least 8 characters');
      for (const field of ['required_points', 'forbidden_points']) {
        if (raw.goal[field] !== undefined && (!Array.isArray(raw.goal[field]) || raw.goal[field].some((item) => typeof item !== 'string'))) problems.push(`goal.${field} must be a string array`);
      }
    }
  } else if (raw.goal !== undefined && raw.goal !== null) {
    problems.push('terminal status must not include a goal');
  }
  if (raw.reason !== undefined && typeof raw.reason !== 'string') problems.push('reason must be a string when present');
  let execution = null;
  if (raw.execution != null) {
    const e = raw.execution;
    if (!materialBindings || !e || typeof e !== 'object' || Array.isArray(e)) problems.push('execution requires caller material_bindings and an object');
    else {
      if (raw.status !== 'goal_ready') problems.push('terminal status must not include execution');
      if (Object.keys(e).some(k => !['type', 'stage_id', 'resend_requested'].includes(k))) problems.push('unexpected execution field');
      if (!['write_message', 'send_material'].includes(e.type)) problems.push('invalid execution.type');
      if (e.type === 'send_material' && !materialBindings.some(b => b.stage_id === e.stage_id)) problems.push('execution.stage_id must name a caller-provided material binding');
      if (e.resend_requested !== undefined && typeof e.resend_requested !== 'boolean') problems.push('resend_requested must be boolean');
      if (e.type === 'write_message' && (e.stage_id !== undefined || e.resend_requested !== undefined)) problems.push('write_message execution must not contain stage_id');
      execution = e.type === 'send_material' ? { type: e.type, stage_id: e.stage_id, ...(e.resend_requested !== undefined ? { resend_requested: e.resend_requested } : {}) } : { type: e.type };
    }
  }
  if (problems.length) return { ok: false, problems };
  const goal = raw.status === 'goal_ready' ? {
    instruction: raw.goal.instruction.trim(),
    required_points: raw.goal.required_points ?? [],
    forbidden_points: raw.goal.forbidden_points ?? [],
  } : null;
  return { ok: true, value: { status: raw.status, goal, reason: raw.reason?.trim() ?? '', ...(materialBindings ? { execution } : {}) } };
}

export function buildGoalResultSchema() {
  return {
    type: 'object', additionalProperties: false,
    required: ['status', 'requires_message', 'goal', 'reason', 'request_id', 'conversation_revision'],
    properties: {
      status: { type: 'string', enum: ['goal_ready', 'wait', 'no_matching_option', 'do_not_contact'] },
      requires_message: { type: 'boolean' },
      goal: {
        type: ['object', 'null'], additionalProperties: false,
        required: ['instruction', 'required_points', 'forbidden_points'],
        properties: {
          instruction: { type: 'string' },
          required_points: { type: 'array', description: 'Only confirmed factual information to mention, preferably short exact quotes from state evidence. No communicative directives, questions, prohibitions, unknown facts, or planned checks; use [] when unnecessary.', items: { type: 'string' } },
          forbidden_points: { type: 'array', description: 'Prohibitions for the writer. Actions belong in instruction, confirmed facts in required_points.', items: { type: 'string' } },
        },
      },
      execution: executionSchema(),
      reason: { type: 'string' },
      request_id: { type: 'string' },
      conversation_revision: { type: ['string', 'null'] },
    },
  };
}
