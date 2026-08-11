from backend.code_agent.model_gateway import (
    has_long_lived_provider_secret,
    job_environment,
    mint_attempt_grant,
    mint_gateway_capability,
    verify_gateway_capability,
)
import pytest


def test_attempt_grant_maps_only_short_lived_claude_names():
    grant = mint_attempt_grant(7, "https://gateway.invalid/attempt/7", "opaque-coding-model")
    environment = job_environment(grant)
    assert set(environment) == {"ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL"}
    assert environment["ANTHROPIC_MODEL"] == "opaque-coding-model"
    assert not has_long_lived_provider_secret(environment)


def test_job_environment_rejects_long_lived_provider_and_control_plane_secrets():
    assert has_long_lived_provider_secret({"ANTHROPIC_API_KEY": "never-in-job"})
    assert has_long_lived_provider_secret({"DATABASE_URL": "postgresql://redacted"})


def test_gateway_capability_is_attempt_bound_and_signed(monkeypatch):
    monkeypatch.setenv("MODEL_GATEWAY_SIGNING_SECRET", "test-gateway-secret")
    token, expires_at = mint_gateway_capability(
        grant_id="grant-1",
        task_id="task-1",
        attempt_id=3,
        owner_user_id="alice",
        provider_profile_id="profile-1",
    )
    payload = verify_gateway_capability(token, grant_id="grant-1")
    assert payload["task_id"] == "task-1"
    assert payload["attempt_id"] == 3
    assert expires_at.endswith("+00:00")
    with pytest.raises(ValueError):
        verify_gateway_capability(token, grant_id="grant-2")
