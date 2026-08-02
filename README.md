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

python -m uvicorn backend.app:app --host 127.0.0.1 --port 8008 --reload
```

The API starts at `http://127.0.0.1:8008`.

Optional capability-specific variables:

- `DASHSCOPE_API_KEY` for TraitAgent.
- `PAPER_AGENT_CHAT_MODEL` and `PAPER_AGENT_VISION_MODEL` to select supported
  OpenAI-compatible models.

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

## Docker

```bash
docker build -t infinity-agents .
docker run --rm -p 8008:8008 \
  -e DATABASE_URL="postgresql://app_user:your_password@host:5432/app_db" \
  -e MOONSHOT_API_KEY="your_key" \
  infinity-agents
```

## Repository scope

`main` intentionally contains only the Python runtime: `agent/`, `backend/`,
`scripts/`, tests, and Python dependency/configuration files. The Cloudflare
Worker and web frontend are maintained separately on the `cloudflare-deploy`
branch; they are not a dependency of this runtime.
