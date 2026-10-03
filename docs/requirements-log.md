# Флаги требований — trained-assist-communication-skills

Источник контракта: [docs/spec.md](spec.md). Ревью ТЗ: trained-assist/trained-agent-architecture#125 (comment 5954560205).
Статусы: `planned` · `in-progress` · `done`. Каждый пункт проверяем — песочницей (S-сценарии), smoke или staging.

| # | Требование | Проверка | Статус |
|---|---|---|---|
| R1 | `generate_next_message_to_conversation_partner`: ОДНО сообщение по цели; не выбирает шаг процесса, не отправляет | S2–S5, S8–S10 | done |
| R2 | `evaluate_message_quality`: тот же вход + сообщение → вердикт ok/repeat/low_quality/style_mismatch/constraint_violated, без генерации | S6, S7 | done |
| R3 | Guard после генерации — общий retry budget, не перемножается между adapter/MCP/ladder (ровно N вызовов лестницы) | S3, S4 | done |
| R4 | Обязательные параметры: goal, communication_style, language (явный код), conversation_history (tagged union messages/text) | S2, handshake-схема | done |
| R5 | Неясные роли в text-истории → needs_context; роли никогда не выдумываются, пустая история = первое сообщение | S5, S10 | done |
| R6 | Превышение лимита → типизированный INPUT_TOO_LARGE с размерами, без молчаливого slice | S8 | done |
| R7 | Ошибка лестницы/хоста → isError с типизированным кодом, не пустой успешный ответ | S9 | done |
| R8 | `model_profile` — только allowlist, заданный сервером; пин модели для bench — служебный контур | review #125; allowlist в коде (`MODEL_PROFILES`), contract test — шаг «Полная локальная проверка» | in-progress |
| R9 | Телеметрия без PII: метрики без текста диалогов/резюме; replay-corpus — отдельно с обезличиванием | review #125; код телеметрии | done |
| R10 | Feature toggle legacy/communication с явным помеченным fallback; откат не меняет отправленные сообщения | core/HH (отдельные планы agent#2034, hh-skill#125) | planned |
| R11 | Выбор модели — только общий llm-ladder (ladder `conversations`); собственная лестница запрещена (ADR-0001) | песочница: фейковая лестница по реальному HTTP-контракту | done |
| R12 | MCP entrypoint `initialize`/`tools/list`/`tools/call` в `src/mcp/entrypoint.mjs`, оба тула со схемами | S1 | done |
| R13 | Граница: нет HH tokens и HH API; выбор шага/ATS/отправка — у HH | архитектурный обзор (R1–R10 hh-skill#125) | done |
| R14 | CLI contract smoke — прогон контракта без хоста | команды в README | planned |
| R15 | Staging E2E: все пути HH генерации через новый handler, черновик не отправляется сам | отдельный план hh-skill#125 | planned |

Готовность к мержу: R1–R7, R9, R12 закрыты песочницей (S1–S10, 15/15) на живом коде; R13 — архитектурная граница, соблюдена в коде; R8 — allowlist в коде, ждёт контрактного теста; R14 (CLI contract smoke) и R15 — следующие шаги.

Принятое упрощение v1: guard детерминирован и не тратит лестницу; вопросы считаются по знакам вопроса (семантический подсчёт — задача будущего LLM-судьи, бюджета на лишний вызов лестницы в контракте нет).
