# Infinity Agents

An AI agent platform featuring paper searching/summarization with real-time streaming responses via WebSockets. Built using `agno` and FastAPI.

## Table of Contents

- [Introduction](#introduction)
- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)
- [Run it locally](#run-it-locally)
- [Run it in Docker](#run-it-in-docker)
- [Testing](#testing)
- [License](#license)

## Introduction

Infinity Agents is an AI-based tool designed to assist with research tasks. It combines conversational AI agents for research assistance.

## Features

- **Paper AI**: Give it a topic, it will search articles using ArXiv, PubMed, and DuckDuckGo, then summarize the most relevant ones for you. (Access via main chat interface)
- **Chater**: A general conversational AI, optionally enhanced with Retrieval-Augmented Generation (RAG) using uploaded documents. (Access via main chat interface)
- **Paper cache model**: Single global paper cache under `papers/cache` + per-session pointers in PostgreSQL (`authorized_paper_refs`, `session_paper_links`).
- **Paper reading model**: `read_paper` supports arXiv ID/URL only and reuses cached PDFs under `papers/cache/downloads` before downloading.

## Quick Start

1.  **Clone & Install:**
    ```bash
    git clone https://github.com/Vist233/Infinity_Agents.git
    cd Infinity_Agents
    pip install -r requirements.txt
    ```

2.  **Set env vars:**
    ```bash
    export DATABASE_URL="postgresql://app_user:your_password@localhost:5432/app_db"
    export MOONSHOT_API_KEY="your_api_key_here"
    ```

3.  **Run:**
    ```bash
    python -m uvicorn backend.app:app --host 127.0.0.1 --port 8008 --reload
    ```

## Usage

After starting the server, access:

- **Chat Interface**: `http://127.0.0.1:3000`

### Features

- **PaperAI**: Research assistant that searches academic papers
- **Chater**: General conversational AI assistant

## Docker Deployment

```bash
# Build image
docker build -t infinite-agents .

# Run backend container (connects external PostgreSQL via DATABASE_URL)
docker run --rm \
  -p 8008:8008 \
  -e DATABASE_URL="postgresql://app_user:your_password@host:5432/app_db" \
  -e MOONSHOT_API_KEY="your_key" \
  infinite-agents
```

Backend API at: `http://localhost:8008`

## Legacy SQLite Migration

Run one-off migration from `papers/sessions.db` and `papers/sessions/*/papers.db` to PostgreSQL:

```bash
python scripts/migrate_sqlite_to_pg.py --database-url "$DATABASE_URL"
```

Notes:
- Migration is environment-local. Run it independently on local and cloud databases.
- The script merges legacy `papers/sessions/*` paper artifacts into a single global cache root (`papers/cache`) without duplicating files.

## Testing

Run tests with:
```bash
pytest tests/
```

## License

This project is licensed under the Apache-2.0 license.

