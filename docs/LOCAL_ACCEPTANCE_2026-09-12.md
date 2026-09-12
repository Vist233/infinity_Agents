# Local-first acceptance — 2026-09-12

This record covers the local-only branch `codex/local-first-runtime`. No
Cloudflare, SSH, or production service was contacted.

## Supported launcher

Prerequisites: Python 3.11 with the `Agent` environment, Docker Desktop with
Compose, Node.js/npm, and a checkout of this repository. From the repository
root:

```bash
pyenv shell Agent
pip install -r requirements.txt
bash scripts/run-local.sh
```

`run-local.sh` is a foreground supervisor. Keep that terminal open. It starts
PostgreSQL, Redis, FastAPI, Next.js, and the local Worker. Open
`http://localhost:3000`; stop with Ctrl-C or, from another terminal,
`bash scripts/stop-local-stack.sh`.

The generated `.env.local` defaults to `CODE_AGENT_EXECUTOR_MODE=local-fixture`.
That deterministic executor writes a JSON result without a model credential so
the full local state and Artifact path can be checked. Set it to `direct` only
for a real locally configured model provider.

## Commands and results

Frontend dependencies and production build:

```text
cd frontend && npm ci         # added 713 packages in 8s
cd frontend && npm run typecheck  # passed
cd frontend && npm run build     # compiled successfully; 9 static pages generated
```

Fresh local infrastructure and supervisor:

```text
bash scripts/run-local.sh      # PostgreSQL healthy; Redis healthy; migrations complete
curl http://127.0.0.1:8008/health
=> {"status":"ready","postgres":true,"redis":true}
curl -I http://127.0.0.1:3000/
=> HTTP/1.1 200 OK
```

While the supervisor was attached, all three PID files were live and the
Worker log contained `Worker local-worker started, waiting for tasks...`.
The final post-commit fresh run specifically recorded API PID `85998`, frontend
PID `86000`, and Worker PID `86002` as alive.

Task/Attempt/Artifact acceptance, including idempotency and API download:

```bash
set -a; source .env.local; set +a
python scripts/local-acceptance.py
```

Recorded result from the fresh local stack:

```text
IDEMPOTENCY first_new=True replay_new=False same_task=True
TASK_ATTEMPT_ARTIFACT=succeeded|1|succeeded
ARTIFACT_SIZE=646
RECORDED_SHA=7dd9af9de57c7f51ec42a4dc12714f0b261dee43f4256391996138f7a62fa76a
STORED_SHA=7dd9af9de57c7f51ec42a4dc12714f0b261dee43f4256391996138f7a62fa76a
DOWNLOADED_SHA=7dd9af9de57c7f51ec42a4dc12714f0b261dee43f4256391996138f7a62fa76a
```

The focused Worker v2 real-PostgreSQL suite also passed:

```text
LOCAL_RUNTIME_TEST_DATABASE_URL="$DATABASE_URL" \
  python -m pytest tests/test_local_runtime_api.py -q --timeout=60
=> 6 passed in 1.23s
```

Shutdown verification:

```text
bash scripts/stop-local-stack.sh
=> launcher supervisor exited 0; api=stopped, frontend=stopped, worker=stopped
=> PostgreSQL/Redis containers stopped; named volumes preserved
```

The default local fixture is intentionally not a scientific model result. A
real analysis requires changing the executor mode and configuring a local model
provider; no such credential is needed to start or validate the local product
state machine.
