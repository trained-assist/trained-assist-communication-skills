'use strict';
import { TypedError } from './typed-error.mjs';
// Allow the shared ladder to move past a slow/temporarily unavailable rung while
// keeping one bounded deadline for the complete Communication operation.
export const METHOD_TOTAL_BUDGET_MS = 120000;
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
