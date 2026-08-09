from __future__ import annotations

import pytest

from backend.provider import ProviderProfile
from backend.coding_provider import CodingProviderProfile
from backend.security import SecurityBoundaryError
from backend.secrets import decrypt_secret, encrypt_secret, secret_fingerprint


def test_single_provider_profile_uses_analysis_model(monkeypatch):
    monkeypatch.setenv("APP_ENV", "acceptance")
    monkeypatch.setenv("ANALYSIS_PROVIDER_BASE_URL", "http://127.0.0.1:18008/v1")
    monkeypatch.setenv("ANALYSIS_MODEL_ID", "spy-model")
    monkeypatch.setenv("ANALYSIS_PROVIDER_API_KEY", "local-only")
    profile = ProviderProfile.from_environment()
    assert profile.protocol == "openai-compatible-chat-completions"
    assert profile.model_id == "spy-model"
    assert profile.base_url == "http://127.0.0.1:18008/v1"


def test_provider_rejects_private_url_outside_local_mode(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("ANALYSIS_PROVIDER_BASE_URL", "http://127.0.0.1:8080/v1")
    with pytest.raises(SecurityBoundaryError):
        ProviderProfile.from_environment()


def test_coding_profile_is_anthropic_and_model_id_is_opaque(monkeypatch):
    monkeypatch.setenv("APP_ENV", "acceptance")
    monkeypatch.setenv("CODING_PROVIDER_BASE_URL", "http://127.0.0.1:18009/v1")
    monkeypatch.setenv("CODING_MODEL_ID", "arbitrary-coding-spy")
    profile = CodingProviderProfile.from_environment()
    assert profile.protocol == "anthropic-messages"
    assert profile.model_id == "arbitrary-coding-spy"


def test_provider_secrets_are_enveloped_and_aad_bound(monkeypatch):
    monkeypatch.setenv("SECRET_STORE_KEK", "local-test-kek")
    encrypted = encrypt_secret("opaque-provider-secret", aad="provider:p1:project-a")
    assert "opaque-provider-secret" not in encrypted
    assert decrypt_secret(encrypted, aad="provider:p1:project-a") == "opaque-provider-secret"
    with pytest.raises(Exception):
        decrypt_secret(encrypted, aad="provider:p1:project-b")
    assert secret_fingerprint("opaque-provider-secret") != "opaque-provider-secret"
