#!/usr/bin/env bash
# One command for the sandbox: builds nothing, needs no network, no model, no token.
#
#   scripts/sandbox/run.sh              — the real verdict (exit 0 = every scenario check passed)
#   scripts/sandbox/run.sh --expect-red — assert the CURRENT plan stage: harness green,
#                                         scenario red because the handler is not written yet
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 2

echo "== communication-skills sandbox =="
echo "репозиторий: $ROOT"
node --version

# The skill under test must reach the scripted ladder over real HTTP; the harness starts it
# on an ephemeral 127.0.0.1 port and points LLM_LADDER_URL/LLM_LADDER_TOKEN at it.
export COMMUNICATION_SANDBOX=1
export SANDBOX_CALL_TIMEOUT_MS="${SANDBOX_CALL_TIMEOUT_MS:-45000}"
export LLM_LADDER_URL="${LLM_LADDER_URL_OVERRIDE:-}"
if [ -z "$LLM_LADDER_URL" ]; then unset LLM_LADDER_URL; fi
export LLM_LADDER_TOKEN="${LLM_LADDER_TOKEN_OVERRIDE:-sandbox-token}"

node scripts/sandbox/harness.mjs "$@"
STATUS=$?

case "$STATUS" in
  0)
    echo "ПЕСОЧНИЦА: PASS — все проверки сценария зелёные на живом коде."
    ;;
  10)
    echo "ПЕСОЧНИЦА: ХАРНЕСС ЖИВ, СЦЕНАРИЙ КРАСНЫЙ — цикл замкнут и падает ровно на нереализованной фиче (текущий этап плана)."
    ;;
  *)
    echo "ПЕСОЧНИЦА: FAIL — красные проверки выше; разбираться по ним (см. список «✗»)."
    ;;
esac
exit "$STATUS"