# Infinity Agents

Python-only local edition of Infinity Agents. It provides the FastAPI backend
and paper-research agent runtime; generated papers, downloads, reports, and
local databases are intentionally kept out of Git.

## Run locally

```bash
pyenv shell Agent
pip install -r requirements.txt

export DATABASE_URL="postgresql://app_user:your_password@localhost:5432/app_db"
export MOONSHOT_API_KEY="your_api_key_here"

python -m uvicorn backend.app:app --host 127.0.0.1 --port 8008 --reload
```

The API starts at `http://127.0.0.1:8008`.

## Test

```bash
pyenv shell Agent
pytest tests/
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
Worker and web frontend are maintained separately on `cloudflare-deploy`.
