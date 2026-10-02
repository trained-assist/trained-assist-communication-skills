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

## Статус

- [x] Репозиторий создан, контракт зафиксирован (02.10.2026)
- [ ] handler + MCP entrypoint + contract smoke CLI
- [ ] Регистрация в core (agent#2034)
- [ ] HH adapter, все пути генерации (hh-skill#125)
- [ ] Staging E2E + baseline
