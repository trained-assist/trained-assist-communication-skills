# Сценарий 1: Первый контакт рекрутера с кандидатом

Value: рекрутер получает готовый черновик первого сообщения кандидату, написанный под заданную цель и стиль,
без выдуманных фактов и без автоматической отправки. Это ключевой сценарий эпика #1 (шаги E2E).

## Actors and boundary

- **Потребитель (хост)** — HH-адаптер или любой MCP-хост: выбирает шаг процесса, хранит черновик, показывает preview, отправляет. Всё это — НЕ здесь.
- **Communication MCP** — только: нормализация входа → prompt → вызов общей llm-ladder → guard → возврат черновика с телеметрией.

## Steps

1. Хост вызывает `tools/call` → `generate_next_message_to_conversation_partner` с:
   - `goal: {instruction: "познакомиться и уточнить отсутствующий опыт X", required_points: [...], forbidden_points: [...]}`,
   - `communication_style: {instructions, examples}`,
   - `language: "ru"` (явный код),
   - `conversation_history: {format: "messages", messages: []}` — пустая история = первое сообщение,
   - `partner_profile` / `sender_profile` / `context` / `constraints` — опционально, каждый блок отделён от goal.
2. Handler валидирует вход; неясные роли, конфликт goal↔constraints или отсутствие подтверждённого факта →
   `status: "needs_context"` с `missing_fields`, лестница НЕ вызывается.
3. Иначе: рендер prompt → `POST /v1/chat/completions` к llm-ladder (ladder `conversation`).
4. Guard (тот же код, что и `evaluate_message_quality`): если draft нарушает constraints/стиль → регенерация
   в пределах ОБЩЕГО retry budget; потолок → типизированная ошибка, без перемножения попыток.
5. Ответ: `{status: "generated", message_text, warnings, request_id, generation: {model, prompt_version, contract_version}, usage, timing, input_metrics}`.
   Успех = подготовленный черновик, а не факт отправки.

## Expected observable signal

- Пустой черновик не возвращается никогда: `generated` ⇒ непустой `message_text`.
- Sender не представляется вымышленным именем, если имя не задано.
- `needs_context` ⇒ ни одного обращения к лестнице (S5, S10).
- Guard-retry ⇒ ровно столько вызовов лестницы, сколько разрешает бюджет (S3: 2, S4: потолок).

## Sandbox mapping

`bash scripts/sandbox/run.sh` → сценарии **S2-generate-first-contact**, **S3-guard-retry**, **S4-retry-budget-ceiling**,
**S5-needs-context** в `scripts/sandbox/fixtures.json` (через настоящий MCP `tools/call`, фейковая лестница на эфемерном порту).
