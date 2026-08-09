from backend.code_agent.model_gateway import (
    has_long_lived_provider_secret,
    job_environment,
    mint_attempt_grant,
)


def test_attempt_grant_maps_only_short_lived_claude_names():
    grant = mint_attempt_grant(7, "https://gateway.invalid/attempt/7", "opaque-coding-model")
    environment = job_environment(grant)
    assert set(environment) == {"ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL"}
    assert environment["ANTHROPIC_MODEL"] == "opaque-coding-model"
    assert not has_long_lived_provider_secret(environment)


def test_job_environment_rejects_long_lived_provider_and_control_plane_secrets():
    assert has_long_lived_provider_secret({"ANTHROPIC_API_KEY": "never-in-job"})
    assert has_long_lived_provider_secret({"DATABASE_URL": "postgresql://redacted"})
