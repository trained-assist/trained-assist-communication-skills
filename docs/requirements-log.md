# Флаги требований — trained-assist-communication-skills

Источник контракта: [docs/spec.md](spec.md). Ревью ТЗ: trained-assist/trained-agent-architecture#125 (comment 5954560205).
Статусы: `planned` · `in-progress` · `done`. Каждый пункт проверяем — песочницей (S-сценарии), smoke или staging.

| # | Требование | Проверка | Статус |
|---|---|---|---|
| R1 | `generate_next_message_to_conversation_partner`: ОДНО сообщение по цели; не выбирает шаг процесса, не отправляет | S2–S5, S8–S10 | planned |
| R2 | `evaluate_message_quality`: тот же вход + сообщение → вердикт ok/repeat/low_quality/style_mismatch/constraint_violated, без генерации | S6, S7 | planned |
| R3 | Guard после генерации — общий retry budget, не перемножается между adapter/MCP/ladder (ровно N вызовов лестницы) | S3, S4 | planned |
| R4 | Обязательные параметры: goal, communication_style, language (явный код), conversation_history (tagged union messages/text) | S2, handshake-схема | planned |
| R5 | Неясные роли в text-истории → needs_context; роли никогда не выдумываются, пустая история = первое сообщение | S5, S10 | planned |
| R6 | Превышение лимита → типизированный INPUT_TOO_LARGE с размерами, без молчаливого slice | S8 | planned |
| R7 | Ошибка лестницы/хоста → isError с типизированным кодом, не пустой успешный ответ | S9 | planned |
| R8 | `model_profile` — только allowlist, заданный сервером; пин модели для bench — служебный контур | review #125; contract test | planned |
| R9 | Телеметрия без PII: метрики без текста диалогов/резюме; replay-corpus — отдельно с обезличиванием | review #125; код телеметрии | planned |
| R10 | Feature toggle legacy/communication с явным помеченным fallback; откат не меняет отправленные сообщения | core/HH (отдельные планы agent#2034, hh-skill#125) | planned |
| R11 | Выбор модели — только общий llm-ladder (ladder `conversations`); собственная лестница запрещена (ADR-0001) | песочница: фейковая лестница по реальному HTTP-контракту | done |
| R12 | MCP entrypoint `initialize`/`tools/list`/`tools/call` в `src/mcp/entrypoint.mjs`, оба тула со схемами | S1 | in-progress |
| R13 | Граница: нет HH tokens и HH API; выбор шага/ATS/отправка — у HH | архитектурный обзор (R1–R10 hh-skill#125) | done |
| R14 | CLI contract smoke — прогон контракта без хоста | команды в README | planned |
| R15 | Staging E2E: все пути HH генерации через новый handler, черновик не отправляется сам | отдельный план hh-skill#125 | planned |

Готовность к мержу: R1–R10, R12, R14 закрыты песочницей/CI; R13 — архитектурная граница, уже соблюдена в коде.
