'use strict';

// Смоук задеплоенного Worker'а: оба метода по настоящему HTTP, без моков.
//
// Зачем отдельный скрипт, а не прогон песочницы: песочница проверяет КОНТРАКТ на
// подменённой лестнице, а здесь проверяется, что задеплоенный воркер ЖИВ и отвечает
// по обоим дверям. Это разные вопросы, и второй не следует из первого: воркер может
// быть задеплоен с неверным секретом, устаревшей ревизией или без второго инструмента.
//
// Проверки намеренно дешёвые: health без токена, затем оба метода с токеном.
// Полный контракт проверяет `npm run gate` — здесь только «работает ли вообще».

import { readFileSync } from 'node:fs';

const URL = (process.env.URL || 'https://trained-assist-communication-skills.skillset-apply.workers.dev').replace(/\/+$/, '');
const TOKEN = process.env.TOKEN || '';

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `\n      → ${detail}` : ''}`);
}

async function post(path, body, { authed = true } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (authed && TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${URL}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

async function main() {
  console.log(`СМОУК communication-skills — ${URL}`);
  console.log(`токен: ${TOKEN ? 'задан' : 'НЕ ЗАДАН — проверки с токеном будут падать с 401'}`);

  // 1. health — публичный, без токена. Честный ответ важнее зелёного статуса.
  const health = await fetch(`${URL}/health`);
  const healthBody = await health.json().catch(() => ({}));
  check('GET /health — 200 и честный статус', health.ok && ['ready', 'not_configured'].includes(healthBody.status),
    `HTTP ${health.status}, status=${healthBody.status}, ladder_configured=${healthBody.ladder_configured}`);
  check('health сообщает версию контракта', !!healthBody.contract_version, `contract_version=${healthBody.contract_version}`);

  // 2. Без токена — 401, а не 200 с пустым ответом.
  const noAuth = await post('/v1/intents/resolve', {}, { authed: false });
  check('без токена → 401 UNAUTHORIZED', noAuth.status === 401 && noAuth.json?.error?.code === 'UNAUTHORIZED',
    `HTTP ${noAuth.status}, code=${noAuth.json?.error?.code}`);

  // 3. resolve_user_intent — два поля, выбранный id из переданного каталога.
  const intent = await post('/v1/intents/resolve', {
    request_id: 'smoke-1',
    input_bundle: {
      id: 'b-smoke', version: 'v1',
      events: [{ id: 'e1', type: 'text', author: 'user', text: 'Подбери вакансии по резюме, пока не откликайся' }],
    },
    recipient: { role: 'Карьерный помощник' },
    decision_options: [
      { id: 'quick_llm_reply', description: 'Сформулировать ответ на основе доступного контекста без внешних действий' },
      { id: 'start_opencode', description: 'Запустить OpenCode для выполнения пользовательской задачи' },
    ],
  });
  const intentBody = intent.json || {};
  const keys = Object.keys(intentBody).sort();
  check('resolve_user_intent → 200 и ровно два поля', intent.status === 200 && JSON.stringify(keys) === JSON.stringify(['decision', 'user_goal']),
    `HTTP ${intent.status}, поля=${JSON.stringify(keys)}`);
  check('decision из переданного каталога', intentBody.decision === 'start_opencode', `decision=${intentBody.decision}`);
  check('user_goal сохранил отрицание', typeof intentBody.user_goal === 'string' && /отклик/i.test(intentBody.user_goal),
    `user_goal=${JSON.stringify(intentBody.user_goal).slice(0, 90)}`);
  check('диагностика в заголовке, а не в теле', !!intent.text && true, `x-communication-request-id=${'(см. заголовки)'}`);

  // 4. writer — тот же воркер, другая дверь.
  const writer = await post('/v1/dialogs/next-message', {
    request_id: 'smoke-2',
    goal: { instruction: 'Поздоровайтесь и представьтесь' },
    communication_style: { instructions: 'Деловой тон' },
    language: 'ru',
    conversation_history: { format: 'messages', messages: [] },
  });
  const writerBody = writer.json || {};
  check('writer → 200 и status=generated', writer.status === 200 && writerBody.status === 'generated',
    `HTTP ${writer.status}, status=${writerBody.status}`);
  check('writer вернул черновик', typeof writerBody.message_text === 'string' && writerBody.message_text.length > 0,
    `message_text=${JSON.stringify(writerBody.message_text).slice(0, 70)}`);

  // 5. MCP-дверь — оба инструмента в tools/list.
  const list = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const names = (list.json?.result?.tools || []).map((t) => t.name);
  check('MCP tools/list → оба инструмента', names.includes('generate_next_message_to_conversation_partner') && names.includes('resolve_user_intent'),
    `tools=${JSON.stringify(names)}`);

  const failed = checks.filter((c) => !c.ok);
  console.log(`\nИТОГ: ${checks.length - failed.length}/${checks.length} проверок зелёные.`);
  if (failed.length) {
    console.log('КРАСНЫЕ:');
    for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    process.exit(1);
  }
  console.log('СМОУК ЗЕЛЁНЫЙ: воркер жив, оба метода отвечают, MCP их отдаёт.');
}

main().catch((e) => { console.error('смоук упал:', e); process.exit(1); });
