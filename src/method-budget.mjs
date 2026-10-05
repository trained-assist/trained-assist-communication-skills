'use strict';
import { TypedError } from './typed-error.mjs';
// A live ATS draft on 2026-10-05 showed a valid shared-ladder response arriving
// after a fallback took ~57s, then being discarded at the old 60s method deadline
// while state validation completed. Keep a bounded deadline, but leave enough room
// for that fallback and validation pass.
export const METHOD_TOTAL_BUDGET_MS = 90000;
// All validation/guard repair attempts share the same method deadline. Provider
// fallbacks remain owned by the shared ladder; this adds no independent retries.
export function remainingMethodBudget(started, attempts = 0) {
  const elapsed = Math.max(0, Date.now() - started);
  const remaining = METHOD_TOTAL_BUDGET_MS - elapsed;
  if (remaining <= 0) throw new TypedError('LLM_UNAVAILABLE', 'method dependency budget exhausted', {
    attempts, budget_exhausted: true, budget_ms: METHOD_TOTAL_BUDGET_MS, elapsed_ms: elapsed,
  });
  return remaining;
}
