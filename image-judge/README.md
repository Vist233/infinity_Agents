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

## Release packages

The `main` branch owns the runnable desktop client. The GitHub Actions workflow
`.github/workflows/imagejudge-package.yml` builds the PySide6 application on
native runners and writes release artifacts under `package/`:

- Windows: `ImageJudge-windows-x64.zip` containing `ImageJudge.exe`.
- Linux: `ImageJudge_<version>_amd64.deb` with an `imagejudge` launcher.
- macOS: `ImageJudge-macos.zip` containing the native `ImageJudge.app` bundle
  (the local Apple Silicon build is also named `ImageJudge-macos-arm64.zip`).

Push a tag such as `imagejudge-v0.2.0` to publish both files to a GitHub
Release. The production Worker and static web application stay on the
`cloudflare-deploy` branch.
