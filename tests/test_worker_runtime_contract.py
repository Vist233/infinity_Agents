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


def test_infra_compose_is_lightweight():
    # L5: docker-compose.infra.yml only contains PG + Redis.
    compose = (ROOT / "docker-compose.infra.yml").read_text(encoding="utf-8")
    assert "postgres" in compose
    assert "redis" in compose
    # No Worker, API, or frontend in infra compose.
    assert "Dockerfile.worker" not in compose
    assert "Dockerfile.api" not in compose
    assert "node:" not in compose


def test_worker_runtime_does_not_construct_a_child_docker_command():
    source = (ROOT / "backend" / "code_agent" / "worker" / "claude_runtime.py").read_text(encoding="utf-8")
    assert '"docker"' not in source
    assert "docker run" not in source
