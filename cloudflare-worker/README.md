# Infinity Agents Edge

Cloudflare Worker edge API for the StepFun Coding Plan. It offers an OpenAI-compatible `POST /v1/chat/completions` endpoint and proxies streaming responses without exposing the upstream API key to clients.

## Endpoints

- `GET /health`
- `GET /v1/models` (Bearer token required)
- `POST /v1/chat/completions` (Bearer token required)
- `POST /chat` (alias)

The deployed Worker needs two secrets:

- `STEPFUN_API_KEY`: StepFun Coding Plan key.
- `CLIENT_API_KEY`: token required from API clients.

The original FastAPI service remains the runtime for PostgreSQL-backed sessions, PDF workflows, paper tools, and local code execution. Those capabilities require a container or VM rather than a Worker.
