from __future__ import annotations

from backend.code_agent.worker import direct_runtime


def test_runtime_environment_uses_explicit_claude_settings_not_control_plane_secrets(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "long-lived-key")
    monkeypatch.setenv("ATTEMPT_GATEWAY_URL", "https://gateway.example.com/attempt/1")
    monkeypatch.setenv("ATTEMPT_GATEWAY_TOKEN", "attempt-token")
    monkeypatch.setenv("ATTEMPT_MODEL_ID", "claude-test")
    monkeypatch.setenv("DATABASE_URL", "postgresql://secret")
    monkeypatch.setenv("WORKER_CREDENTIAL", "worker-secret")

    environment = direct_runtime._runtime_environment()

    assert environment["ANTHROPIC_BASE_URL"] == "https://gateway.example.com/attempt/1"
    assert environment["ANTHROPIC_AUTH_TOKEN"] == "attempt-token"
    assert environment["ANTHROPIC_MODEL"] == "claude-test"
    assert "ANTHROPIC_API_KEY" not in environment
    assert "DATABASE_URL" not in environment
    assert "WORKER_CREDENTIAL" not in environment


def test_runtime_environment_fails_closed_without_attempt_gateway(monkeypatch):
    for name in ("ATTEMPT_GATEWAY_URL", "ATTEMPT_GATEWAY_TOKEN", "ATTEMPT_MODEL_ID"):
        monkeypatch.delenv(name, raising=False)
    try:
        direct_runtime._runtime_environment()
    except RuntimeError as exc:
        assert "ATTEMPT_GATEWAY" in str(exc)
    else:
        raise AssertionError("direct runtime must reject missing attempt gateway capability")


def test_command_skips_permissions_inside_the_dedicated_worker_by_default(monkeypatch):
    monkeypatch.delenv("CLAUDE_CODE_ALLOW_ALL", raising=False)
    monkeypatch.delenv("CLAUDE_CODE_ARGS", raising=False)
    monkeypatch.setenv("CLAUDE_CODE_COMMAND", "claude")

    command = direct_runtime._command()

    assert "--print" in command
    assert "--dangerously-skip-permissions" in command


def test_command_can_explicitly_enable_skip_permissions(monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_ALLOW_ALL", "1")
    monkeypatch.delenv("CLAUDE_CODE_ARGS", raising=False)
    monkeypatch.setenv("CLAUDE_CODE_COMMAND", "claude")

    command = direct_runtime._command()

    assert "--dangerously-skip-permissions" in command


def test_execution_command_drops_to_dedicated_claude_uid(monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_COMMAND", "claude")
    monkeypatch.setenv("DIRECT_CLAUDE_REQUIRE_PRIVDROP", "1")
    monkeypatch.setattr(
        direct_runtime.shutil,
        "which",
        lambda name: "/usr/bin/setpriv" if name == "setpriv" else None,
    )

    command = direct_runtime._execution_command()

    assert command[:5] == [
        "/usr/bin/setpriv",
        "--reuid=claude",
        "--regid=claude",
        "--init-groups",
        "--",
    ]
