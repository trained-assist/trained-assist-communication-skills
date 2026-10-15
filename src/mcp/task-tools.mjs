// Caller-authenticated, read-only task replies. No model or dependency probes.
// This registry owns both applicability and product wording.
const emptyInput = { type: 'object', properties: {}, additionalProperties: false };
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const TASK_TOOLS = [
  {
    name: 'system_health',
    description: 'Быстро подтвердить, что сервис отвечает, и предложить отправить задание. Только самостоятельный вопрос о работоспособности самого помощника, включая короткий вопрос без названия компонента. Не диагностика Runner, движка или интеграций, не дополнительные задачи и не работа с файлами.',
    inputSchema: emptyInput, annotations,
  },
  {
    name: 'catalog.brief',
    description: 'Описать зарегистрированные возможности и выданный доступ из каталога профиля. Только самостоятельный вопрос о возможностях; не просьба выполнить работу, проверить файл, создать или изменить данные. Подключение и права не подтверждают работоспособность интеграции.',
    inputSchema: emptyInput, annotations,
  },
];
const invalid = () => ({ isError: true, data: { error: { code: 'INVALID_INPUT', message: 'Invalid task reply arguments or trusted context' } } });
export const TASK_HANDLERS = {
  system_health: async (args) => validArguments(args)
    ? { data: { text: 'Сервис работает! Отправляйте задание!' } } : invalid(),
  'catalog.brief': async (args, _env, context) => {
    const catalog = context?.['trained-assist/context']?.catalog;
    if (!validArguments(args) || !catalog || typeof catalog.version !== 'string' || !Array.isArray(catalog.entries)
      || catalog.entries.some(e => !e || typeof e.id !== 'string' || typeof e.title !== 'string'
        || !['registered', 'granted_readiness_unverified', 'not_connected'].includes(e.availability))) return invalid();
    const entries = catalog.entries.map(e => `${e.title} (${e.id}): ${e.availability === 'registered'
      ? 'зарегистрировано в каталоге' : e.availability === 'not_connected'
        ? 'требует подключения и выдачи доступа' : 'доступ выдан; работоспособность интеграции не проверена'}`);
    return { data: { text: `Остальные задачи передаются агенту. Каталог ${catalog.version}:\n${entries.join('\n')}` } };
  },
};
function validArguments(args) {
  return args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).length === 0;
}
