'use strict';

// Deterministic guard for `resolve_user_intent` — 0 tokens, 0 model calls
// (issue #10 §7: «Валидация ответа обязательна даже с provider JSON Schema»).
//
// WHY A GUARD AT ALL FOR A TWO-FIELD ANSWER. Shape validation alone would let
// through the four ways this method can hurt a caller while looking perfectly
// well-formed — all of them are the resolver's own listed defects:
//
//   1. `decision` outside the list / a `user_goal` that is an empty echo  → shape;
//   2. `user_goal` that restates the APPLICATION's capability instead of the
//      USER's desire («Использовать LLM для ответа») — «Не подменять желание
//      предполагаемыми возможностями приложения» (issue #10 §2);
//   3. `user_goal` asserting a live fact nobody supplied — §7: LLM confidence is
//      not runtime state. Same rule as the writer's invented-time check, which
//      caught a fabricated call slot in a live run;
//   4. `user_goal` asserting what an UNREADABLE attachment contains — §5: «Файл
//      только с manifest позволяет понять "переведи PDF", но не позволяет
//      отвечать о его содержании».
//
// Each check is a decision we can make without semantics. Where we cannot decide
// without semantics we say so instead of guessing: whether two options are both
// applicable is left to the classifier and measured by the labeled corpus.

import { validateIntentOutput } from './intent-schema.mjs';

// A clock time or a date in user_goal. Concrete slots are the highest-consequence
// thing a resolver can fabricate: the caller may act on «в 15:30» as agreed.
const CLOCK_RE = /\d{1,2}[:.]\d{2}/gu;
const CLOCK_WORD_RE = /(?<![\p{L}\p{N}])в\s+\d{1,2}\s*(?:час|ч\.)/giu;
const DATE_RE = /\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?/gu;
const DATE_WORD_RE = /(?<![\p{L}\p{N}])(?:послезавтра|сегодня|завтра)(?![\p{L}\p{N}])/giu;

// «В файле написано…», «документ содержит…» — a claim about content we could not
// read. Distinct from a legitimate goal about the file («переведи PDF»).
const SOURCE_CLAIM_RE = /(?<![\p{L}\p{N}])(?:в файле|в документе|в письме|в приложении|в резюме|в переписке|в сообщении|файл содержит|документ содержит|на картинке|в скриншоте|в аудио|в записи)(?![\p{L}\p{N}])/giu;

/** Everything the caller actually gave us — the only admissible source of facts. */
export function confirmedEvidence(input) {
  const parts = [];
  for (const e of input?.input_bundle?.events || []) parts.push(e.text || '');
  for (const a of input?.input_bundle?.attachments || []) parts.push(a.text || '', a.name || '');
  for (const h of input?.dialog_context?.history || []) parts.push(h.text || '');
  for (const f of input?.runtime_facts || []) parts.push(f.value || '', f.as_of || '');
  for (const c of input?.capabilities || []) parts.push(c.description || '');
  for (const o of input?.decision_options || []) parts.push(o.description || '', o.applicability || '');
  for (const s of input?.source_refs || []) parts.push(s.note || '');
  return parts.join(' ').toLowerCase();
}

/** Collapse to a comparable shape: «Использовать LLM.» == «использовать  llm». */
export function normalizeGoal(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[`"'«»()[\]{}.,;:!?—–-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function unmatchedClaims(goal, evidence, ...res) {
  const found = res.flatMap((re) => goal.match(re) || []);
  return [...new Set(found.map((s) => s.toLowerCase()))].filter((s) => !evidence.includes(s));
}

/**
 * @param {object} args
 * @param {object} args.input normalised intent input
 * @param {unknown} args.output raw parsed model output
 * @param {string[]} args.allowedIds caller ids + NO_MATCHING_OPTION
 * @returns {{verdict: string, reasons: string[], value?: {user_goal: string, decision: string}}}
 */
export function runIntentGuard({ input, output, allowedIds }) {
  const shape = validateIntentOutput(output, allowedIds);
  if (!shape.ok) {
    return { verdict: 'shape_invalid', reasons: shape.problems };
  }
  const goal = shape.value.user_goal;

  // 2. the goal must be the user's desire, not the app's capability restated
  const normalizedGoal = normalizeGoal(goal);
  for (const o of input?.decision_options || []) {
    for (const candidate of [o.description, o.applicability]) {
      if (candidate && normalizeGoal(candidate) === normalizedGoal) {
        return {
          verdict: 'goal_is_option',
          reasons: [`user_goal дословно повторяет описание варианта «${o.id}»: «${String(candidate).slice(0, 80)}» — это формулировка возможности приложения, а не желание пользователя`],
        };
      }
    }
  }

  const evidence = confirmedEvidence(input);

  // 3. no live facts nobody supplied. Runtime facts are the ONLY admissible source,
  //    so a goal that names a concrete time/date absent from the input is a
  //    fabrication regardless of how plausible it looks.
  const inventedTime = unmatchedClaims(goal, evidence, CLOCK_RE, CLOCK_WORD_RE, DATE_RE, DATE_WORD_RE);
  if (inventedTime.length) {
    return {
      verdict: 'invented_time',
      reasons: [`user_goal называет время/дату, которых нет во входе: «${inventedTime.join('», «')}» — живые факты задаёт вызывающая сторона (runtime_facts), а не модель`],
    };
  }

  // 4. no claims about content we were never given
  const unreadable = (input?.input_bundle?.attachments || []).filter((a) => !a.text?.trim());
  if (unreadable.length) {
    const claims = unmatchedClaims(goal, evidence, SOURCE_CLAIM_RE);
    if (claims.length) {
      return {
        verdict: 'unavailable_source',
        reasons: [`user_goal утверждает содержимое источника, которое не передано: «${claims.join('», «')}» — вложения без текста (${unreadable.map((a) => a.name || a.id).join(', ')}) не прочитаны, содержимое по имени не выдумывается`],
      };
    }
  }

  return { verdict: 'ok', reasons: [], value: shape.value };
}
