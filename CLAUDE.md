# Repository instructions

Read [README.md](README.md) and the specific state/goal/writer/resolver contract in docs. One handler serves REST/MCP/test adapters; use the shared LLM Ladder. Preserve full-history/revision, closed-list selection and local output validation contracts. Do not invent routing outcomes or trim history to an arbitrary fixed tail.

Документы содержат действующие требования, контракты и инструкции. Планы выполнения, статусы, ревью прошлых версий и evidence ведутся в GitHub issues/PR/Project. Целевая модель не является утверждением о текущем deployment; его готовность проверяется по конкретным SHA и приёмке.

Tests/fixtures and model-quality/live evidence are distinct. Use a separate branch; coordinate shared Worker config, timeouts and deployment with the integrator.

Retiring GCP VM is not a development or fallback target. Use the own Agent Run API and serverless by default; a necessary persistent service belongs on the existing French VM. Other Google services remain allowed. Exit coordination: https://github.com/trained-assist/trained-agent-architecture/issues/145.
