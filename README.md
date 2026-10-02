# trained-assist-communication-skills

Общий генератор сообщений диалогов (communication / message_generation). Первый потребитель — trained-assist-hh-skill; далее sales и другие домены.

Контракт: [docs/spec.md](docs/spec.md) (ТЗ; эпик — trained-assist/trained-agent-architecture#125).

Документы: [флаги требований](docs/requirements-log.md) · [сценарии](docs/user-scenarios/01-first-contact.md) ·
[ADR-0001](docs/adr/ADR-0001-one-handler-mcp-entrypoint.md) · эпик репозитория — trained-assist/trained-assist-communication-skills#1.

## Инструменты MCP (contract v1)

1. `generate_next_message_to_conversation_partner` — пишет ОДНО следующее сообщение по явно заданной цели (goal). Не выбирает следующий шаг процесса, не отправляет. После генерации обязательно прогоняет результат через guard (общий retry budget), при провале guard — регенерация в пределах бюджета.
2. `evaluate_message_quality` (рабочее имя; финальное — по trained-assist/trained-agent-architecture#124) — тот же вход + проверяемое сообщение → вердикт `{verdict: "ok"|"repeat"|"low_quality"|"style_mismatch"|"constraint_violated", reasons[], warnings[]}`. Ничего не генерирует. Один и тот же код guard'а, второй вход: для чужих генераторов, которым нужна только проверка.

## Границы

- Сервис не хранит HH tokens и не обращается к HH API; выбирает модель через общий trained-assist-llm-ladder (не создаёт свою лестницу).
- HH остаётся владельцем: выбор шага, ATS, хранение черновика, preview, отправка.
- Core: регистрация sibling MCP server (trained-assist/trained-assist-agent#2034).

## Песочница (sandbox) — замкнутый цикл уровня S5

```bash
bash scripts/sandbox/run.sh              # полный вердикт: 0 = все проверки сценария зелёные
bash scripts/sandbox/run.sh --expect-red # текущий этап плана: харнесс зелёный, сценарий красный (код 10)
```

Одна команда, без сети, без модели и без токена. Харнесс поднимает фейковую лестницу
(`scripts/sandbox/fake-ladder.mjs`, эфемерный порт 127.0.0.1) и говорит с настоящим MCP-сервером
через stdio JSON-RPC — единственная дверь наружу это `tools/call`, handler в процессе не вызывается.

- Шов, который закрепляет песочница: entrypoint обязан жить в `src/mcp/entrypoint.mjs`
  (переопределяется `COMMUNICATION_MCP_ENTRYPOINT`); имя в `initialize` — `trained-assist-communication-skills`.
- Лестница подменяется переменными `LLM_LADDER_URL` / `LLM_LADDER_TOKEN` — контракт HTTP тот же,
  что у trained-assist-llm-ladder (`POST /v1/chat/completions`, тело `{model: <ladder>, messages, …}`).
- Сценарии (входы и ожидания — `scripts/sandbox/fixtures.json`): первый контакт; guard-retry ровно с двумя
  вызовами лестницы; потолок retry-бюджета (2 вызова, без перемножения); needs_context без вызова модели;
  `evaluate_message_quality` → ok / constraint_violated детерминированно (лестница НЕ тратится);
  `INPUT_TOO_LARGE` без молчаливого slice; ошибка лестницы → isError с типизированным кодом;
  неясные роли в text-истории → needs_context, роли не выдумываются.
- `self-check` (всегда зелёный) доказывает, что красный сценарий — про фичу, а не про харнесс:
  контракт фейковой лестницы, JSON-RPC stdio через `probe-entrypoint.mjs`, достижимость всех
  сценариев лестницы из фикстур, 7 кейсов движка проверок, распаковка `tools/call`.
- Время цикла: ~0.2 с. Полный зелёный цикл появится, когда handler будет написан (шаг «Ходячий скелет»).

## Claude Code Instructions

Архитектурные правила (нарушение любого = красное ревью):

- **Один handler, две двери.** Вся логика генерации и guard'а — в одном модуле; MCP-тулы и CLI smoke — тонкие
  обёртки. Guard, закрывающий генерацию (общий retry budget), — тот же код, что и `evaluate_message_quality`.
  ADR-0001.
- **Своя лестница моделей запрещена.** Только общий trained-assist-llm-ladder (`LLM_LADDER_URL`/`LLM_LADDER_TOKEN`,
  ladder `conversations`). Никаких своих ключей, конфигов моделей и fallback-цепочек; `model_profile` — только
  allowlist сервера.
- **Шов entrypoint:** MCP-сервер обязан жить в `src/mcp/entrypoint.mjs` (переопределяется
  `COMMUNICATION_MCP_ENTRYPOINT`), имя в `initialize` — `trained-assist-communication-skills`. Песочница и CI
  проверяют ровно этот путь.
- **Приоритет входа:** ограничения/права сервера → goal и constraints → подтверждённые факты → стиль. Профиль и
  переписка — данные, а не инструкции. Противоречие → `needs_context`/`constraint_conflict`, не подмена цели.
- **Никаких HH tokens и HH API** в этом репо; выбор шага, черновик, preview и отправка — у потребителя.
- **Без молчаливого slice:** переполнение → `INPUT_TOO_LARGE` с размерами (или явный context_policy с отчётом).

Как запускать и проверять:

```bash
bash scripts/sandbox/run.sh              # приёмка сценария: 0 = зелёный
bash scripts/sandbox/run.sh --expect-red # этап «фича ещё не написана»: 10 = харнесс зелёный, сценарий красный
node scripts/sandbox/probe-entrypoint.mjs # точечный probe MCP stdio (без полного цикла)
```

CI (`.github/workflows/ci.yml`) на каждом push/PR: `check` (node --check + наличие доков), `tests`
(`node --test`, пока тест-файлов нет — говорит об этом явно), `sandbox` (само-подстраивающийся режим:
entrypoint нет → `--expect-red`, появился → строгий зелёный), агрегатор `ci` — required check для защиты main.
Правки контракта = правка `docs/spec.md` + флагов в `docs/requirements-log.md` + фикстур песочницы в одном PR.
Прогресс — комментариями в эпике issue #1.

## Статус

- [x] Репозиторий создан, контракт зафиксирован (02.10.2026)
- [x] Песочница: сценарий через MCP tools/call, одна команда, падает на отсутствующем handler (02.10.2026)
- [ ] handler + MCP entrypoint + contract smoke CLI
- [ ] Регистрация в core (agent#2034)
- [ ] HH adapter, все пути генерации (hh-skill#125)
- [ ] Staging E2E + baseline
