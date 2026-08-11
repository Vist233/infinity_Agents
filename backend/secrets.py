"""Small envelope-encryption boundary for project-scoped provider credentials."""

from __future__ import annotations

import base64
import hashlib
import os
import secrets

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def _key() -> bytes:
    raw = os.getenv("SECRET_STORE_KEK", "").strip()
    if raw:
        try:
            decoded = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))
            if len(decoded) == 32:
                return decoded
        except (ValueError, TypeError):
            pass
        return hashlib.sha256(raw.encode("utf-8")).digest()
    if os.getenv("APP_ENV", "development").lower() not in {"development", "dev", "test"}:
        raise RuntimeError("SECRET_STORE_KEK is required outside development/test")
    # A stable fallback is intentionally limited to local development and
    # tests. Acceptance/staging must fail closed rather than silently sharing
    # a repository-known encryption key.
    return hashlib.sha256(b"infinity-agents-development-secret-store").digest()


def encrypt_secret(value: str, *, aad: str) -> str:
    if not value:
        raise ValueError("secret cannot be empty")
    nonce = secrets.token_bytes(12)
    ciphertext = AESGCM(_key()).encrypt(nonce, value.encode("utf-8"), aad.encode("utf-8"))
    return "v1." + base64.urlsafe_b64encode(nonce + ciphertext).decode("ascii").rstrip("=")


def decrypt_secret(payload: str, *, aad: str) -> str:
    if not payload or not payload.startswith("v1."):
        raise ValueError("unsupported secret envelope")
    raw = base64.urlsafe_b64decode(payload[3:] + "=" * (-len(payload[3:]) % 4))
    if len(raw) <= 12:
        raise ValueError("invalid secret envelope")
    value = AESGCM(_key()).decrypt(raw[:12], raw[12:], aad.encode("utf-8"))
    return value.decode("utf-8")


def secret_fingerprint(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[-12:]
