'use strict';

export const GOAL_STATUSES = Object.freeze(['goal_ready', 'wait', 'no_matching_option']);

export function buildGoalDecisionSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['status'],
    properties: {
      status: { type: 'string', enum: [...GOAL_STATUSES] },
      goal: {
        type: 'object',
        additionalProperties: false,
        required: ['instruction'],
        properties: {
          instruction: { type: 'string', minLength: 8, description: 'Open-ended next action for the writer, derived from the conversation objective and current state.' },
          required_points: { type: 'array', items: { type: 'string' } },
          forbidden_points: { type: 'array', items: { type: 'string' } },
        },
      },
      reason: { type: 'string', description: 'Optional explanation; may be empty.' },
    },
  };
}

export function validateGoalDecision(raw) {
  const problems = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, problems: ['answer must be a JSON object'] };
  for (const key of Object.keys(raw)) if (!['status', 'goal', 'reason'].includes(key)) problems.push(`unexpected field: ${key}`);
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
  if (problems.length) return { ok: false, problems };
  const goal = raw.status === 'goal_ready' ? {
    instruction: raw.goal.instruction.trim(),
    required_points: raw.goal.required_points ?? [],
    forbidden_points: raw.goal.forbidden_points ?? [],
  } : null;
  return { ok: true, value: { status: raw.status, goal, reason: raw.reason?.trim() ?? '' } };
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
          required_points: { type: 'array', items: { type: 'string' } },
          forbidden_points: { type: 'array', items: { type: 'string' } },
        },
      },
      reason: { type: 'string' },
      request_id: { type: 'string' },
      conversation_revision: { type: ['string', 'null'] },
    },
  };
}
