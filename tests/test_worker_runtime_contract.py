from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_only_unified_worker_runtime_and_image_are_production_entries():
    worker_dir = ROOT / "backend" / "code_agent" / "worker"
    assert (worker_dir / "consumer.py").is_file()
    assert (worker_dir / "claude_runtime.py").is_file()
    assert (ROOT / "backend" / "Dockerfile.worker").is_file()
    for removed in (
        worker_dir / "cloudflare_worker.py",
        worker_dir / "docker_runtime.py",
        worker_dir / "fixture_executor.py",
        ROOT / "backend" / "Dockerfile.fixture-worker",
    ):
        assert not removed.exists(), f"legacy production entry remains: {removed}"


def test_local_startup_is_native_postgres_only():
    assert not (ROOT / "docker-compose.infra.yml").exists()
    start = (ROOT / "scripts" / "start-local.sh").read_text(encoding="utf-8")
    env = (ROOT / ".env.local.example").read_text(encoding="utf-8")
    assert "pg_isready" in start
    assert "docker" not in start.lower()
    assert "redis" not in start.lower()
    assert "API_PROXY_TARGET" in start
    assert "http://${API_HOST}:${API_PORT}" in start
    assert "REDIS_URL" not in env

    next_config = (ROOT / "frontend" / "next.config.ts").read_text(encoding="utf-8")
    assert "http://localhost:8008" in next_config


def test_worker_runtime_does_not_construct_a_child_docker_command():
    source = (ROOT / "backend" / "code_agent" / "worker" / "claude_runtime.py").read_text(encoding="utf-8")
    assert '"docker"' not in source
    assert "docker run" not in source
    assert "dangerously-skip-permissions" not in source
    assert "validate_claude_command" in source
