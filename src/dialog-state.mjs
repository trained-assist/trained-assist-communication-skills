'use strict';

// Dialog state — extractive, deterministic, zero LLM calls (issue #6 §4).
//
// WHY EXTRACTIVE AND NOT A SUMMARISER. The spec calls this layer «обязательное
// состояние диалога»: answered questions, refusals, do-not-contact, promises.
// It also says compression here is «преимущественно экстрактивное» and that a
// cheap LLM *may* extract. We deliberately do NOT call a model for this, because:
//
//  1. Every fact we need carries a hard requirement — «не выдумывать», «не
//     повторять отвеченный вопрос», «запрет контакта не обсуждается». A
//     paraphrase that inverts a negation («не готов переезжать» → «готов
//     переезжать») is a recruiting disaster, and no prompt makes that safe to
//     rely on.
//  2. Keeping VERBATIM QUOTES + source message ids makes every claim auditable
//     and lets the guard reason over the same text the writer saw.
//  3. It costs 0 tokens. An extractor LLM would spend ~10x the whole draft call
//     to save nothing we can actually verify.
//
// What we CANNOT decide deterministically is left explicitly `unknown` rather
// than guessed. That is the honest floor, and the spec demands exactly this:
// «Не придумывать отсутствующие даты и роли» (#6 §3).

// This repo's contract says `speaker: "sender" | "partner" | "other"`; issue #6
// words the same role `author: "sender" | "interlocutor"`. Both spellings are
// accepted — a state layer that only understands one of them makes every partner
// turn invisible, which fails SILENTLY (no do-no-contact, no answered questions)
// and is the worst possible failure shape for a guard.
const SENDER = 'sender';
const PARTNER = 'interlocutor';
const PARTNER_ALIASES = new Set([PARTNER, 'partner']);

// Refusal / decline markers. Deliberately broad on DECLINE and narrow on
// DO-NOT-CONTACT: a missed refusal costs one awkward message, a missed contact
// ban is a real-world harm.
const DECLINE_RE = [
  /не\s+готов/iu, /не\s+хочу/iu, /не\s+желаю/iu, /не\s+рассматрива/iu,
  /не\s+могу/iu, /не\s+планир/iu, /не\s+переезж/iu, /не\s+соглас/iu,
  /не\s+подходит/iu, /не\s+актуально/iu, /не\s+интерес/iu,
  /отказ/iu, /исключ(ен|ить|аю)/iu, /pass/iu, /not\s+interested/iu,
];

// «Больше не пишите» and friends. Lookbehind/lookahead reject «напишите» — that
// is the PARTNER asking US to write, the opposite of a contact ban.
const DNC_RE = [
  /(?<![а-яё])пиши(те)?(?![а-яё])(?![а-яё])/iu, // handled with the ban frame below
  /больше\s+не\s+(пиши|звоните|пишите|звонните|беспокойте|связывайтесь)/iu,
  /не\s+пиши(те)?\s+мне/iu,
  /не\s+хочу\s+(общаться|получать\s+сообщения)/iu,
  /не\s+желаю\s+(общаться|получать\s+сообщения)/iu,
  /прекратите\s+(звонить|писать|беспокоить)/iu,
  /удалите\s+меня/iu,
  /откажитесь\s+от\s+меня/iu,
  /do\s+not\s+contact/iu,
  /stop\s+(contacting|writing|messaging)/iu,
  /unsubscribe/iu,
  /remove\s+me/iu,
];

// «Напишите» must not read as «пишите». Checked as a whole-word negative guard
// on the DNC match rather than by trimming the regex, so the ban frame
// «больше не пишите» still matches.
const BENIGN_WRITE_RE = /напишите/iu;

const PROMISE_RE = [
  /(пришл[уе]|отправлю|направлю|вышлю)/iu,
  /(созвонимся|созвониться|перезвоню|перезвонить)/iu,
  /(обсудим|обсуждаем)/iu,
  /(подготовим|подготовить)/iu,
];

const MONEY_RE = /\d[\d\s ]*(?:₽|руб(?:\.|лей|ля|\.)?|тыс\.?\s*руб|\$|€|eur)/iu;
const DATE_RE = /\d{1,2}[.\/]\d{1,2}(?:[.\/]\d{2,4})?|\b(?:понедельник|вторник|среда|четверг|пятница|суббота|воскресенье)\b/iu;

function norm(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function messageList(history) {
  if (!history || history.format !== 'messages') return [];
  return Array.isArray(history.messages) ? history.messages : [];
}

function isSender(m) { return !!m && (m.speaker === SENDER || m.author === SENDER); }
function isPartner(m) {
  if (!m) return false;
  const role = m.speaker ?? m.author;
  return PARTNER_ALIASES.has(role);
}

function hasDecline(text) { return DECLINE_RE.some((re) => re.test(text)); }

/** A contact ban, judged ONLY on partner turns. A recruiter asking the partner
 *  to write («напишите, пожалуйста, когда удобно») must never trip this. */
function detectDoNotContact(messages) {
  const evidence = [];
  for (const m of messages) {
    if (!isPartner(m)) continue;
    const text = norm(m.text);
    if (!text) continue;
    for (const re of DNC_RE) {
      if (!re.test(text)) continue;
      // «напишите» alone = a request, not a ban. A ban frame («больше не пишите»)
      // outranks the benign guard because it can never appear in «напишите».
      if (BENIGN_WRITE_RE.test(text) && !/больше\s+не/iu.test(text) && !/не\s+пишите\s+мне/iu.test(text)) continue;
      evidence.push({
        message_id: m.id || null,
        speaker: PARTNER,
        quote: text.slice(0, 300),
        matched: String(re),
      });
      break;
    }
  }
  return evidence.length ? { detected: true, evidence } : { detected: false, evidence: [] };
}

/** Questions each side asked, with the answer linkage and a status per question. */
function extractQuestions(messages) {
  const questions = [];
  const partnerQuestions = [];

  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    const text = norm(m && m.text);
    if (!text || !text.includes('?')) continue;

    if (isSender(m)) {
      // The answer is the FIRST partner turn after this question. Linking to the
      // next question instead would mis-attribute a short «да» (regression case 3).
      const answer = messages.slice(i + 1).find((n) => isPartner(n) && norm(n.text));
      const answerText = norm(answer && answer.text);
      let status = 'unanswered';
      if (answerText) {
        if (hasDecline(answerText)) status = 'declined';
        else status = 'answered';
      }
      questions.push({
        id: `q${questions.length + 1}`,
        asked_by: SENDER,
        text: text.slice(0, 400),
        message_id: m.id || null,
        status,
        answer_message_id: answerText ? (answer.id || null) : null,
        answer_quote: answerText ? answerText.slice(0, 400) : null,
      });
    } else if (isPartner(m)) {
      // Regression case 9: the partner's open question must not be ignored in
      // favour of the sender's goal. We report only what is STRUCTURALLY true:
      //   no_reply — nothing from the sender follows; certainly unanswered.
      //   replied  — the sender did speak after, but deciding whether that
      //              reply actually answered THIS question needs semantics we
      //              refuse to fake. We say so instead of guessing, and ask the
      //              writer to check the history rather than re-ask blindly
      //              (a false «unanswered» would violate R1, which is worse).
      const replied = messages.slice(i + 1).find((n) => isSender(n) && norm(n.text));
      partnerQuestions.push({
        id: `pq${partnerQuestions.length + 1}`,
        text: text.slice(0, 400),
        message_id: m.id || null,
        status: replied ? 'replied' : 'no_reply',
      });
    }
  }
  return { questions, partnerQuestions };
}

/** Commitments by either side, verbatim. Negation inside a quote is preserved
 *  because we never rewrite the text — this is the whole point of extractive.
 *  A question is not a commitment: «Когда удобно созвониться?» is the partner
 *  ASKING, and labelling it a promise would tell the writer to honour a
 *  scheduling intent the partner never expressed. */
function extractCommitments(messages) {
  const out = [];
  for (const m of messages) {
    const text = norm(m && m.text);
    if (!text || text.includes('?')) continue;
    if (!PROMISE_RE.some((re) => re.test(text))) continue;
    out.push({
      party: isSender(m) ? SENDER : isPartner(m) ? PARTNER : 'unknown',
      quote: text.slice(0, 300),
      message_id: m.id || null,
    });
  }
  return out;
}

/**
 * Full mandatory dialog state over the COMPLETE history (issue #6 §4 step 3 —
 * built before any topical selection, never after).
 *
 * @param {object} history normalised conversation_history
 * @returns {object} state; every entry keeps a verbatim quote + source id.
 */
export function extractDialogState(history) {
  const messages = messageList(history);
  const { questions, partnerQuestions } = extractQuestions(messages);
  const dnc = detectDoNotContact(messages);

  const partnerTurns = messages.filter((m) => isPartner(m)).map((m) => norm(m.text)).filter(Boolean);

  const conditions = [];
  for (const t of partnerTurns) {
    if (MONEY_RE.test(t) || DATE_RE.test(t)) {
      conditions.push({
        quote: t.slice(0, 300),
        declined: hasDecline(t),
      });
    }
  }

  return {
    version: 1,
    messages_seen: messages.length,
    do_not_contact: dnc,
    questions,
    partner_questions: partnerQuestions,
    commitments: extractCommitments(messages),
    conditions,
    // Facts we cannot establish without guessing stay explicitly unknown
    // (issue #6 §4: «неподтверждённые факты не становятся ограничениями
    // автоматически»). The writer is told to ask rather than assume.
    unverified: partnerTurns.length === 0,
  };
}

/** Short, deterministic rendering for the writer prompt. Kept compact on
 *  purpose: every line here is re-billed on every call. */
export function renderDialogState(state) {
  if (!state) return '';
  const lines = [];

  if (state.do_not_contact?.detected) {
    lines.push('ЗАПРЕТ КОНТАКТА. Собеседник прямо попросил больше не писать. Ответ не пиши — верни no_message_needed.');
  }
  if (state.questions?.length) {
    const answered = state.questions.filter((q) => q.status === 'answered');
    const declined = state.questions.filter((q) => q.status === 'declined');
    const unanswered = state.questions.filter((q) => q.status === 'unanswered');
    if (answered.length) {
      lines.push(`Уже отвечено (не переспрашивай): ${answered.map((q) => `"${q.text}" → "${q.answer_quote}"`).join('; ')}`);
    }
    if (declined.length) {
      lines.push(`Собеседник отказался отвечать (не возвращайся к этому): ${declined.map((q) => `"${q.text}" → "${q.answer_quote}"`).join('; ')}`);
    }
    if (unanswered.length) {
      lines.push(`Осталось без ответа: ${unanswered.map((q) => `"${q.text}"`).join('; ')}`);
    }
  }
  const unansweredFromPartner = state.partner_questions?.filter((q) => q.status === 'no_reply') || [];
  const repliedTo = state.partner_questions?.filter((q) => q.status === 'replied') || [];
  if (unansweredFromPartner.length) {
    lines.push(`НЕЗАКРЫТЫЕ ВОПРОСЫ СОБЕСЕДНИКА — на них нет ответа, ответь (они не про нашу цель): ${unansweredFromPartner.map((q) => `"${q.text}"`).join('; ')}`);
  }
  if (repliedTo.length) {
    lines.push(`Вопросы собеседника, после которых был ответ: ${repliedTo.map((q) => `"${q.text}"`).join('; ')}. Проверь по истории, отвечены ли они — не переспрашивай повторно.`);
  }
  if (state.commitments?.length) {
    lines.push(`Обещания сторон (не нарушай и не выдумывай новых): ${state.commitments.map((c) => `${c.party}: "${c.quote}"`).join('; ')}`);
  }
  if (state.conditions?.length) {
    lines.push(`Условия собеседника (передай дословно, включая отрицание): ${state.conditions.map((c) => `"${c.quote}"${c.declined ? ' [ОТКАЗ]' : ''}`).join('; ')}`);
  }
  if (state.unverified) {
    lines.push('Подтверждённых ответов собеседника в истории нет — не выдумывай факты, уточни.');
  }
  return lines.length ? lines.join('\n') : '';
}

/** Sizes for telemetry — counts only, never text (no PII in logs). */
export function stateMetrics(state) {
  return {
    messages_seen: state.messages_seen,
    questions_total: state.questions.length,
    questions_answered: state.questions.filter((q) => q.status === 'answered').length,
    questions_declined: state.questions.filter((q) => q.status === 'declined').length,
    questions_unanswered: state.questions.filter((q) => q.status === 'unanswered').length,
    open_partner_questions: state.partner_questions.filter((q) => q.status === 'no_reply').length,
    partner_questions_replied: state.partner_questions.filter((q) => q.status === 'replied').length,
    commitments: state.commitments.length,
    do_not_contact: state.do_not_contact.detected,
  };
}
