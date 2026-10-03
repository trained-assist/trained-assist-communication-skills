# ADR-0001: Один handler, MCP entrypoint и CLI smoke; своя лестница моделей запрещена

Status: Accepted · 2026-10-02 · Эпик: trained-assist/trained-assist-communication-skills#1

## Контекст

Сервис должен обслуживать два типа потребителей: любой MCP-хост (через `generate_next_message_to_conversation_partner`
и `evaluate_message_quality`) и доменные адаптеры (сейчас HH — выбор шага, черновики, отправка остаются там).
Уже есть ревью контракта (trained-assist/trained-agent-architecture#125): два метода, общий retry budget,
model_profile только по allowlist, PII-телеметрия, feature toggle.

## Решение

1. **Один handler** — вся логика генерации и guard'а живёт в одном месте; MCP-тулы и CLI smoke — тонкие обёртки над ним.
   Guard, которым закрывается генерация (retry budget), — тот же код, что и отдельный `evaluate_message_quality`:
   два входа в одну проверку, а не две реализации.
2. **MCP entrypoint** в `src/mcp/entrypoint.mjs` (переопределяется `COMMUNICATION_MCP_ENTRYPOINT`): `initialize` /
   `tools/list` / `tools/call`. Это шов, который закрепляет песочница, и единственная дверь наружу.
3. **CLI contract smoke** — быстрый прогон контракта без хоста (для CI и отладки), не замена песочнице.
4. **Своя лестница запрещена.** Выбор модели — только общий trained-assist-llm-ladder (ladder `conversation`).
   Никаких собственных конфигов моделей, ключей и fallback-цепочек: это дублирование, которое потом никто не обслуживает.
5. **Core не импортирует entrypoint соседа** — регистрация идёт как sibling MCP server
   (trained-assist/trained-assist-agent#2034), через каталог и конфиг, а не через require из core.

## Последствия

- Плюс: одна точка правды по guard'у/бюджету попыток — общий retry budget не перемножается между adapter, MCP и ladder.
- Плюс: песочница и CI проверяют ровно тот путь, который уйдёт в прод (stdio JSON-RPC, реальный HTTP-контракт лестницы).
- Минус: изменение контракта требует синхронного обновления схем, фикстур и потребителей (HH адаптер — отдельный план).
- Риск: entrypoint вне `src/mcp/entrypoint.mjs` ломает шов — CI и песочница падают, это и есть защита.
