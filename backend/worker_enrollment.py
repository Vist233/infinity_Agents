"""Short-lived Worker enrollment and revocable per-machine credentials.

The enrollment token is accepted once and never returned from the database.
The resulting credential is stored only as a digest.  This module deliberately
does not share user OIDC sessions or Provider credentials with Workers.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional


class WorkerEnrollmentError(RuntimeError):
    """A Worker cannot be enrolled or authenticated."""


class DuplicateWorkerError(WorkerEnrollmentError):
    """The requested Worker ID already has an active credential."""


@dataclass(frozen=True)
class EnrollmentToken:
    worker_id: str
    namespace: str
    token: str
    expires_at: str


def credential_digest(value: str) -> str:
    """Hash a high-entropy enrollment/Worker credential for storage."""

    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()


def _safe_worker_id(value: str) -> str:
    worker_id = str(value or "").strip()
    if not worker_id or len(worker_id) > 128 or any(ch.isspace() for ch in worker_id):
        raise WorkerEnrollmentError("invalid worker ID")
    return worker_id


def _safe_namespace(value: str) -> str:
    namespace = str(value or "").strip()
    if not namespace or len(namespace) > 128 or any(ch.isspace() for ch in namespace):
        raise WorkerEnrollmentError("invalid worker namespace")
    return namespace


async def issue_enrollment_token(pool, worker_id: str, namespace: str, *, ttl_seconds: int = 600) -> EnrollmentToken:
    worker_id = _safe_worker_id(worker_id)
    namespace = _safe_namespace(namespace)
    if ttl_seconds < 30 or ttl_seconds > 3600:
        raise WorkerEnrollmentError("enrollment token TTL is outside the local safety range")
    raw = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds)
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO worker_enrollment_tokens (token_hash, worker_id, namespace, expires_at)
            VALUES ($1, $2, $3, $4)
            """,
            credential_digest(raw), worker_id, namespace, expires,
        )
    return EnrollmentToken(worker_id, namespace, raw, expires.isoformat())


async def complete_enrollment(pool, worker_id: str, namespace: str, token: str) -> str:
    """Consume a one-time token and return a new per-Worker credential."""

    worker_id = _safe_worker_id(worker_id)
    namespace = _safe_namespace(namespace)
    token_hash = credential_digest(token)
    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                """
                SELECT token_hash, worker_id, namespace, expires_at, used_at
                FROM worker_enrollment_tokens
                WHERE token_hash = $1
                FOR UPDATE
                """,
                token_hash,
            )
            if not row or row["worker_id"] != worker_id or row["namespace"] != namespace:
                raise WorkerEnrollmentError("enrollment token is invalid")
            if row["used_at"] is not None or row["expires_at"] <= datetime.now(timezone.utc):
                raise WorkerEnrollmentError("enrollment token is expired or already used")
            existing = await conn.fetchrow(
                """
                SELECT worker_id FROM worker_enrollments
                WHERE worker_id = $1 AND namespace = $2 AND status = 'active' AND revoked_at IS NULL
                FOR UPDATE
                """,
                worker_id, namespace,
            )
            if existing:
                raise DuplicateWorkerError("worker ID already has an active enrollment")
            credential = secrets.token_urlsafe(32)
            await conn.execute(
                "UPDATE worker_enrollment_tokens SET used_at = NOW() WHERE token_hash = $1",
                token_hash,
            )
            await conn.execute(
                """
                INSERT INTO worker_enrollments (worker_id, credential_hash, namespace, status, last_seen_at)
                VALUES ($1, $2, $3, 'active', NOW())
                """,
                worker_id, credential_digest(credential), namespace,
            )
            return credential


async def authenticate_worker(pool, worker_id: str, namespace: str, credential: str) -> bool:
    """Validate a Worker credential and update its last-seen timestamp."""

    worker_id = _safe_worker_id(worker_id)
    namespace = _safe_namespace(namespace)
    supplied = credential_digest(credential)
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT credential_hash FROM worker_enrollments
            WHERE worker_id = $1 AND namespace = $2 AND status = 'active' AND revoked_at IS NULL
            """,
            worker_id, namespace,
        )
        if not row or not hmac.compare_digest(str(row["credential_hash"]), supplied):
            return False
        await conn.execute(
            """
            UPDATE worker_enrollments SET last_seen_at = NOW()
            WHERE worker_id = $1 AND namespace = $2 AND status = 'active' AND revoked_at IS NULL
            """,
            worker_id, namespace,
        )
    return True


async def revoke_worker(pool, worker_id: str, namespace: str) -> bool:
    worker_id = _safe_worker_id(worker_id)
    namespace = _safe_namespace(namespace)
    async with pool.acquire() as conn:
        result = await conn.execute(
            """
            UPDATE worker_enrollments
            SET status = 'revoked', revoked_at = NOW()
            WHERE worker_id = $1 AND namespace = $2 AND status = 'active'
            """,
            worker_id, namespace,
        )
    return result.endswith(" 1")
