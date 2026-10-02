# trained-assist-communication-skills

Общий генератор сообщений диалогов (communication / message_generation). Первый потребитель — trained-assist-hh-skill; далее sales и другие домены.

Контракт: [docs/spec.md](docs/spec.md) (ТЗ; эпик — trained-assist/trained-agent-architecture#125).

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

## Статус

- [x] Репозиторий создан, контракт зафиксирован (02.10.2026)
- [x] Песочница: сценарий через MCP tools/call, одна команда, падает на отсутствующем handler (02.10.2026)
- [ ] handler + MCP entrypoint + contract smoke CLI
- [ ] Регистрация в core (agent#2034)
- [ ] HH adapter, все пути генерации (hh-skill#125)
- [ ] Staging E2E + baseline
