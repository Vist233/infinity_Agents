# Infinity Agents

Infinity Agents is a Python research-Agent runtime for breeding-research
workflows. The `main` branch intentionally contains the reproducible core:
FastAPI, persistent research sessions, and the three domain capabilities below.
Generated papers, downloads, reports, and local databases stay out of Git.

## Core capabilities

- **PaperAgent** — retrieve, read, cache, and extract methods from academic
  papers; uploaded PDFs are converted into canonical Markdown for inspection.
- **CodeAgent** — run scoped research/data-analysis tasks with artifact-aware
  plotting tools.
- **TraitAgent** — analyze breeding trait images with a vision-capable model.

## Multi-source literature search

PaperAgent exposes `search_literature` for public-source discovery. Its default
sources are **PubMed**, **Europe PMC**, and **arXiv**; each source receives an
8-second budget, so a slow provider returns a partial result instead of holding
up the workflow. Use `sources` to opt into `semantic`, `openalex`, `pmc`, or
`crossref`, and use `fields` to limit the returned metadata.

```text
search_literature(
  query="Brassica resistance gene family",
  fields=["title", "abstract", "doi", "pdf_url"],
  open_access_only=true,
  limit=5
)
```

Search results are metadata only. Pass a returned public `pdf_url` to
`read_paper` when full-text extraction is needed. The source adapters are a
curated MIT-licensed subset of
[`openags/paper-search-mcp`](https://github.com/openags/paper-search-mcp);
the notice and license are in `agent/vendor/paper_search_mcp/`.

## Architecture

```text
Client or local UI
       |
 REST + WebSocket (/ws/chat)
       |
FastAPI runtime
  |- PostgreSQL: sessions, messages, tool calls, paper references
  |- session sandbox: papers/sessions/<session_id>
  |- shared paper cache: papers/cache
  `- PaperAgent / CodeAgent / TraitAgent
```

## Run locally

```bash
pyenv shell Agent
pip install -r requirements.txt

export DATABASE_URL="postgresql://app_user:your_password@localhost:5432/app_db"
export MOONSHOT_API_KEY="your_api_key_here"
# zhang-auth OIDC access tokens are required for every session API request.
export OIDC_ISSUER="https://auth.zhangyvjing.com"
export OIDC_AUDIENCE="infinity-agents"

python -m uvicorn backend.app:app --host 127.0.0.1 --port 8008 --reload
```

The API starts at `http://127.0.0.1:8008`.

Optional capability-specific variables:

- `DASHSCOPE_API_KEY` for TraitAgent.
- `PAPER_AGENT_CHAT_MODEL` and `PAPER_AGENT_VISION_MODEL` to select supported
  OpenAI-compatible models.
- `OIDC_JWKS_URL` and `OIDC_JWKS_TTL_SECONDS` when using a non-default
  zhang-auth JWKS endpoint.
- `CORS_ALLOWED_ORIGINS` as a comma-separated allowlist (defaults to the
  production site and local frontend).

Session endpoints require `Authorization: Bearer <OIDC access token>`. The
WebSocket endpoint accepts the same token only in its initial JSON frame:
`{ "session_id": "…", "access_token": "…", "messages": [...] }`.

## Test

```bash
pyenv shell Agent
pytest -q
```

The default suite is self-contained. To run the live paper-source and
PostgreSQL integration check, configure `DATABASE_URL` and run:

```bash
RUN_INTEGRATION_TESTS=1 pytest -q tests/test_search_papers.py
```

## Repository scope

`main` intentionally contains only the Python runtime: `agent/`, `backend/`,
`scripts/`, tests, and Python dependency/configuration files. The Cloudflare
Worker and web frontend are maintained separately on the `cloudflare-deploy`
branch; they are not a dependency of this runtime.
