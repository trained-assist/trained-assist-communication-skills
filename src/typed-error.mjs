'use strict';

// Shared primitives: one typed error class and one PII-free log line writer.
//
// They used to live inside handler.mjs, which made a second method (resolve_user_intent)
// either import the writer's module for an error class — a dependency between two
// independent contracts — or define its own, which would have split `instanceof
// TypedError` across the transport layer. One class, one logger, two methods.

export class TypedError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TypedError';
    this.code = code;
    this.details = details;
  }
}

// Telemetry: только идентификаторы, статусы и размеры — ни текста диалогов, ни PII.
export function logEvent(evt, fields) {
  try { console.error(`[communication] ${JSON.stringify({ evt, ...fields })}`); } catch { /* stderr best-effort */ }
}
