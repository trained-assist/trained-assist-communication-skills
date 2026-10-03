'use strict';

// Dialog state — the mandatory-state layer of issue #6 §4, tested against the
// regression list in §8. All deterministic: no ladder, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractDialogState, renderDialogState, stateMetrics } from '../src/dialog-state.mjs';

const msg = (speaker, text, id = null) => ({ id, speaker, text });
const S = (text, id) => msg('sender', text, id);
const P = (text, id) => msg('partner', text, id);
const hist = (...messages) => ({ format: 'messages', messages });

test('R2: «больше не пишите» → detected, и только на реплике собеседника', () => {
  const st = extractDialogState(hist(S('Давайте созвонимся', 'm1'), P('Больше не пишите мне, пожалуйста.', 'm2')));
  assert.equal(st.do_not_contact.detected, true);
  assert.equal(st.do_not_contact.evidence[0].message_id, 'm2');
  // The evidence is a verbatim quote — a paraphrase could invert the meaning.
  assert.match(st.do_not_contact.evidence[0].quote, /Больше не пишите/);
});

test('R2: recruiter asking the partner to write is NOT a contact ban', () => {
  // The dangerous false positive: «Напишите, пожалуйста, удобное время» is the
  // recruiter ASKING. Treating it as a ban would silently drop a real draft.
  const st = extractDialogState(hist(P('Когда удобно созвониться?', 'm1'), S('Напишите, пожалуйста, удобное время', 'm2')));
  assert.equal(st.do_not_contact.detected, false);
});

test('R2: «напишите мне» от собеседника — просьба, не запрет', () => {
  const st = extractDialogState(hist(P('Напишите мне, когда будет информация', 'm1')));
  assert.equal(st.do_not_contact.detected, false);
});

test('R1: вопрос с ответом 100 сообщений назад остаётся отвеченным', () => {
  const thread = [S('Какой у вас опыт с 5-осевой фрезеровкой?', 'q1'), P('Да, три года.', 'a1')];
  for (let i = 0; i < 50; i += 1) thread.push(msg(i % 2 ? 'partner' : 'sender', `Болтовня номер ${i}`));
  const st = extractDialogState(hist(...thread));
  const q = st.questions.find((x) => x.id === 'q1');
  assert.equal(q.status, 'answered');
  assert.equal(q.answer_message_id, 'a1');
  assert.match(renderDialogState(st), /не переспрашивай/);
});

test('R3: короткое «да» относится к предыдущему вопросу, связь сохранена', () => {
  const st = extractDialogState(hist(S('Есть опыт? Есть CAD? Есть Python?', 'm1'), P('да', 'm2')));
  assert.equal(st.questions[0].status, 'answered');
  assert.equal(st.questions[0].answer_quote, 'да');
});

test('R6: отказ фиксируется как declined, а цитата сохраняет отрицание', () => {
  const st = extractDialogState(hist(S('Где готовы работать?', 'm1'), P('Офис не рассматриваю, только удалённо', 'm2')));
  assert.equal(st.questions[0].status, 'declined');
  // The single most important property: the negation survives verbatim, so no
  // downstream paraphrase can turn «не рассматриваю офис» into «рассматриваю офис».
  assert.match(st.questions[0].answer_quote, /не рассматриваю/);
  assert.match(renderDialogState(st), /не возвращайся к этому/);
});

test('R9: вопрос собеседника без ответа помечен no_reply', () => {
  const st = extractDialogState(hist(S('Есть опыт?', 'm1'), P('Да. А когда сможете выйти?', 'm2')));
  const open = st.partner_questions.find((q) => q.status === 'no_reply');
  assert.ok(open);
  assert.match(open.text, /когда сможете выйти/i);
  assert.match(renderDialogState(st), /НЕЗАКРЫТЫЕ ВОПРОСЫ/);
});

test('R9: после вопроса был ответ — статус replied, а не выдуманный no_reply', () => {
  // We cannot tell deterministically whether the reply answered the question.
  // Guessing «unanswered» would violate R1 (re-asking a settled question), so we
  // report the structural truth and let the writer check the history.
  const st = extractDialogState(hist(P('Когда сможете выйти?', 'm1'), S('Выхожу в понедельник', 'm2')));
  assert.equal(st.partner_questions[0].status, 'replied');
  assert.match(renderDialogState(st), /Проверь по истории/);
});

test('вопрос собеседника не считается обещанием', () => {
  const st = extractDialogState(hist(P('Когда удобно созвониться?', 'm1')));
  assert.equal(st.commitments.length, 0);
});

test('обещание автора фиксируется дословно', () => {
  const st = extractDialogState(hist(S('Я вышлю задание завтра', 'm1')));
  assert.equal(st.commitments.length, 1);
  assert.equal(st.commitments[0].party, 'sender');
  assert.match(st.commitments[0].quote, /вышлю задание/);
});

test('обещание собеседника не теряет отрицание', () => {
  const st = extractDialogState(hist(P('Я перезвоню только после отпуска', 'm1')));
  assert.match(st.commitments[0].quote, /только после отпуска/);
});

test('issue #6 §3: author:"interlocutor" тоже читается как собеседник', () => {
  // The two specs word the same role differently; supporting only one would make
  // every partner turn invisible — a SILENT guard failure.
  const st = extractDialogState({
    format: 'messages',
    messages: [{ author: 'sender', text: 'Здравствуйте' }, { author: 'interlocutor', text: 'Больше не пишите мне' }],
  });
  assert.equal(st.do_not_contact.detected, true);
});

test('пустая история → состояние без выдуманных фактов', () => {
  const st = extractDialogState(hist());
  assert.equal(st.messages_seen, 0);
  assert.equal(st.do_not_contact.detected, false);
  assert.equal(st.questions.length, 0);
  assert.equal(st.unverified, true);
});

test('метрики содержат только счётчики, без текста (no PII in telemetry)', () => {
  const st = extractDialogState(hist(S('Вопрос про зарплату?', 'm1'), P('Хочу 200000 рублей', 'm2')));
  const m = stateMetrics(st);
  const blob = JSON.stringify(m);
  assert.ok(!blob.includes('зарплату'), 'текст диалога не должен попадать в метрики');
  assert.ok(!blob.includes('200000'), 'суммы не должны попадать в метрики');
  assert.equal(m.messages_seen, 2);
  assert.equal(m.questions_answered, 1);
  assert.equal(typeof m.do_not_contact, 'boolean');
});

test('формат text без ролей не порождает состояние', () => {
  // Roles are unknown, so no question can be attributed. Returning an empty state
  // (rather than guessing) is the honest answer; the handler turns this into
  // needs_context before we ever get here.
  const st = extractDialogState({ format: 'text', text: '— Здравствуйте\n— А вы кто?' });
  assert.equal(st.questions.length, 0);
  assert.equal(st.do_not_contact.detected, false);
});
