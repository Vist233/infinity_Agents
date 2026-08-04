# ImageJudge

ImageJudge is the local desktop client for two-image visual classification.

## Repository layout

- `apps/desktop/`: PySide6 desktop client, local SQLite persistence, CSV projection, and BYOK gateway.
- `apps/worker/`: standalone Worker module used for local contract tests and development.
- `docs/`: handover and deployment notes.
- `tests/`: Python unit and integration tests.
- `installer/`: Windows installer metadata.

The production platform proxy is integrated into the sibling `cloudflare-worker/`
application in this repository under `cloudflare-worker/src/image-judge/` and is
served at `/image-judge/*` by the existing Infinity Edge Worker. The desktop
client remains a separate local application and never receives the platform
DashScope key.

## Local checks

```bash
PYENV_VERSION=Agent pyenv exec python -m pytest image-judge/tests -q
PYENV_VERSION=Agent pyenv exec python -m compileall -q image-judge/apps/desktop/imagejudge
```
