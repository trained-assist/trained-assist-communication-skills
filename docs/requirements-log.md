# Флаги требований — trained-assist-communication-skills

Источник контрактов: [docs/spec.md](spec.md) (writer) и [docs/resolve-user-intent-contract.md](resolve-user-intent-contract.md) (resolver). ТЗ: [#6](https://github.com/trained-assist/trained-assist-communication-skills/issues/6), [#10](https://github.com/trained-assist/trained-assist-communication-skills/issues/10).
Статусы: `done` · `deferred (почему)` · `planned`. Каждый пункт проверяем — песочницей, юнит-тестами, корпусом или живым прогоном.

| # | Требование | Проверка | Статус |
|---|---|---|---|
| R1 | ОДНО сообщение по цели; не выбирает шаг процесса, не отправляет | S2, S8–S10 | done |
| R2 | Guard после генерации — общий retry budget, не перемножается (ровно 2 вызова) | S3, S4 | done |
| R3 | Обязательные параметры: goal, communication_style, language, conversation_history | S2, handshake-схема | done |
| R4 | Неясные роли в text-истории → needs_context; роли не выдумываются | S10 | done |
| R5 | Превышение лимита → INPUT_TOO_LARGE с размерами, без молчаливого slice | S8 | done |
| R6 | Ошибка лестницы → isError с типизированным кодом | S9 | done |
| R7 | `model_profile` — только allowlist сервера | код (`MODEL_PROFILES`), юнит-тест | done |
| R8 | Телеметрия без PII: только счётчики и размеры | юнит-тест «метрики содержат только счётчики» | done |
| R9 | Выбор модели — только общий llm-ladder (ladder `conversation`) | песочница: фейковая лестница по реальному HTTP-контракту | done |
| R10 | MCP entrypoint `initialize`/`tools/list`/`tools/call` | S1 | done |
| R11 | Граница: нет HH tokens и HH API | архитектурный обзор | done |
| R12 | Рантайм — Cloudflare Worker, без VM | `wrangler.jsonc`, живой прогон на workerd | done |
| R13 | Две двери над одним handler'ом: MCP HTTP + REST | `test/worker.test.mjs` (18 тестов) | done |
| R14 | Состояние диалога: отвеченные/отказанные вопросы, запрет контакта, обещания | `test/dialog-state.test.mjs` (15), S6, S7 | done |
| R15 | Запрет контакта → `no_message_needed`, модель не вызывается | S6, живой прогон (14 мс, 0 вызовов) | done |
| R16 | Guard ловит переспрос решённого вопроса | `test/guard-dialog-state.test.mjs` | done |
| R17 | Guard ловит выдуманное время | юнит-тесты + живой прогон (2 попытки → корректный вопрос) | done |
| R18 | Повтор после отклонения объясняет модели, ЧТО не так | живой прогон: попытка 1 выдумала время, попытка 2 спросила | done |
| R19 | Песочница проверяет, что реально дошло до модели (`prompt_contains`) | S7 | done |
| R20 | Сжатие относительно цели (contract v1.1) | — | deferred: нет измеренной потребности; история ≤ 8 сообщений ≈ 1800 токенов, сжатие дороже передачи целиком |
| R21 | Embeddings (BGE-M3) + Vectorize + RRF | — | deferred: то же; векторный поиск по ≤ 1800 токенов не оправдан |
| R22 | 30 размеченных сценариев (issue #6 §8) | — | deferred: 17 регрессионных кейсов покрыты тестами; полный корпус — отдельная задача |
| R23 | Регистрация в core (agent#2034) | — | planned: отдельный план |
| R24 | Адаптер рекрутинга (hh-skill#125) | — | planned: отдельный план |
| R25 | resolve_user_intent: двухполевой контракт, ровно два поля в успехе | `test/intent-schema.test.mjs`, песочница I11/I20/I21 | done |
| R26 | Динамическая JSON Schema на каждый запрос: enum = переданные ids + no_matching_option, required, additionalProperties:false | `test/intent-schema.test.mjs`, песочница I11/I25 (`response_format_json_schema` + `decision_enum`) | done |
| R27 | Замена списка решений меняет разрешённые id без изменения кода метода | `test/intent-schema.test.mjs`, `test/intent-handler.test.mjs`, корпус I25/I26, песочница I25 | done |
| R28 | Серверная валидация после вызова даже с provider JSON Schema | `test/intent-schema.test.mjs` (неизвестный id, лишние поля, короткая цель) | done |
| R29 | Входной контракт: input_bundle, recipient, decision_options; остальное опционально | `test/intent-handler.test.mjs` (все поля и все ошибки) | done |
| R30 | no_matching_option нельзя передать как пользовательский id | `test/intent-handler.test.mjs`, корпус E05 | done |
| R31 | Описание варианта обязательно и содержательно («Decision 3» не годится) | `test/intent-handler.test.mjs`, корпус E07 | done |
| R32 | decision_priority: только между применимыми, id вне списка отклоняется | `test/intent-handler.test.mjs`, корпус I06/I07, песочница I15/I16 | done |
| R33 | Манифест ≠ содержимое: вложение без текста помечено непрочитанным | `test/intent-prompt.test.mjs`, `test/intent-handler.test.mjs`, песочница I17/I23 | done |
| R34 | Объявленный доступным, но не переданный текст → warning, а не молчаливая потеря | `test/intent-handler.test.mjs` | done |
| R35 | Guard: форма, копия описания варианта, выдуманное время, содержимое недоступного источника | `test/intent-guard.test.mjs` (12 тестов) | done |
| R36 | Одна ремонтная попытка с причиной; бюджет метода = 2 вызова лестницы | `test/intent-handler.test.mjs`, песочница I19/I20/I30 | done |
| R37 | Техническая ошибка не становится no_matching_option | `test/intent-handler.test.mjs`, песочница I29, корпус I14 | done |
| R38 | Диагностика в транспортном контексте (_meta / заголовки), версия пакета возвращается | `test/worker.test.mjs`, `test/intent-handler.mjs`, живой прогон на workerd | done |
| R39 | Телеметрия без PII: только счётчики, id и выбранный id решения | `test/intent-handler.test.mjs` | done |
| R40 | Ни одного вызова наружу, кроме общей лестницы (чужой tenant недоступен) | `test/intent-handler.test.mjs` (единственный fetch — лестница) | done |
| R41 | 72 размеченных кейса на пяти каталогах решений | `scripts/corpus/cases.json`, `test/intent-corpus.test.mjs` | done |
| R42 | Офлайн-корпус: ноль потерянных ограничений, ноль выдуманных live-фактов | `test/intent-corpus.test.mjs` | done |
| R43 | Живой замер качества resolver'а (corpus:live) | — | deferred: нужны секреты общей лестницы; офлайн-прогон честно не притворяется измерением модели |
| R44 | Блочное извлечение каркаса для длинного ввода (#10 §6.3) | — | deferred: вход ≤ 120000 символов идёт целиком, выше — явная INPUT_TOO_LARGE; компрессор стоит N вызовов и рискует потерять отрицание |
| R45 | Embeddings для отбора истории (#10 §6.4) | — | deferred: то же, что R21; все decision options всегда доходят до выбора |
| R46 | Workers AI как классификатор (#10 §7) | — | отклонено: ADR-0001 запрещает собственную конфигурацию моделей и ключи |
| R47 | Регистрация resolver'а в core (agent#2034) | — | planned: отдельный план |

## Замеры, на которых основаны deferred-решения

Живой `llm-ladder`, `/v1/analytics?hours=720` (30 дней):

| лестница | вызовов | входных токенов | USD |
|---|---:|---:|---:|
| `free` | 24715 | 41.5M | 5.47 |
| `conversations` | 1126 | 3.37M | 1.05 |
| всего | 65428 | 51.4M | 8.35 |

Вывод, который изменил объём работ: метод написания сообщений — 6.6% входных токенов организации, а не главный потребитель. Оптимизация токенов здесь не окупает переписывание; окупает качество (переспрос отвеченного вопроса, письмо человеку, попросившему не писать).

Второй замер: `tokens_cached = 0` на всех 65k вызовов. Лестница поддерживает sticky-кэш промпта (`ladder_conversation`), но клиенты его не передают. Это отдельная задача в `trained-assist-hh-skill`, не здесь.

## Известные ограничения

- Guard сравнивает слова дословно, без лемматизации: «логистику» ≠ «логистикой». Дословный повтор ловится, близкий перефраз — нет. Зафиксировано тестом как факт.
- «Отвечен ли вопрос» определяется структурой (есть ли реплика после), а не смыслом. Неопределённое помечается `replied`, а не угадывается.
- Сжатия нет: вход > 120000 символов → `INPUT_TOO_LARGE`.
- **Применимость вариантов — семантика, не детерминированная проверка.** «Два применимых без приоритета → `no_matching_option`» обеспечивается схемой и промптом, а не кодом. Качество этой границы измеряется корпусом, а не утверждается тестом.
- **Офлайн-корпус не измеряет модель.** `contract_decision_accuracy: 1` в офлайне — утверждение о конвейере. Замер качества требует `npm run corpus:live`.
