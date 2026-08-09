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


@dataclass(frozen=True)
class PersistentWorkerRegistration:
    worker_id: str
    namespace: str
    trust_level: str
    worker_credential: str
    credential_expires_at: str | None = None


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


async def issue_persistent_worker(
    pool,
    *,
    user_id: str,
    namespace: str,
    trust_level: str = "institution_trusted",
    worker_id: str | None = None,
) -> PersistentWorkerRegistration:
    """Create a durable, user-owned Worker registration for local parity."""

    namespace = _safe_namespace(namespace)
    user_id = str(user_id or "").strip()
    if not user_id or len(user_id) > 128:
        raise WorkerEnrollmentError("invalid Worker owner")
    trust_level = str(trust_level or "institution_trusted").strip()
    if trust_level not in {"owner_trusted", "institution_trusted", "student_untrusted"}:
        trust_level = "institution_trusted"
    worker_id = _safe_worker_id(worker_id or f"worker-{secrets.token_urlsafe(9)}")
    credential = secrets.token_urlsafe(32)

    async with pool.acquire() as conn:
        try:
            await conn.execute(
                """
                INSERT INTO worker_enrollments
                    (worker_id, credential_hash, namespace, user_id, trust_level,
                     status, revoked_at, last_seen_at, credential_expires_at)
                VALUES ($1, $2, $3, $4, $5, 'active', NULL, NULL, NULL)
                """,
                worker_id,
                credential_digest(credential),
                namespace,
                user_id,
                trust_level,
            )
        except Exception as exc:
            raise DuplicateWorkerError("worker ID already exists") from exc
    return PersistentWorkerRegistration(worker_id, namespace, trust_level, credential, None)


async def list_persistent_workers(pool, *, user_id: str, online_window_seconds: int = 90) -> list[dict[str, object]]:
    """List only registrations owned by the authenticated local user."""

    from datetime import datetime

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT worker_id, namespace, trust_level, status,
                   credential_expires_at, last_seen_at, enrolled_at, revoked_at
            FROM worker_enrollments
            WHERE user_id = $1
            ORDER BY enrolled_at DESC
            """,
            user_id,
        )

    now = datetime.now(timezone.utc)
    workers: list[dict[str, object]] = []
    for row in rows:
        last_seen = row["last_seen_at"]
        if last_seen is None:
            presence = "never_seen"
        else:
            if last_seen.tzinfo is None:
                last_seen = last_seen.replace(tzinfo=timezone.utc)
            presence = "online" if (now - last_seen).total_seconds() <= online_window_seconds else "offline"

        def iso(value: object) -> str | None:
            return value.isoformat() if hasattr(value, "isoformat") else (str(value) if value is not None else None)

        workers.append({
            "worker_id": row["worker_id"],
            "namespace": row["namespace"],
            "trust_level": row["trust_level"],
            "status": row["status"],
            "presence": presence,
            "credential_expires_at": iso(row["credential_expires_at"]),
            "last_seen_at": iso(row["last_seen_at"]),
            "created_at": iso(row["enrolled_at"]),
            "revoked_at": iso(row["revoked_at"]),
        })
    return workers


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


async def revoke_worker(
    pool,
    worker_id: str,
    namespace: str,
    *,
    user_id: str | None = None,
    allow_other_users: bool = False,
) -> bool:
    worker_id = _safe_worker_id(worker_id)
    namespace = _safe_namespace(namespace)
    async with pool.acquire() as conn:
        result = await conn.execute(
            """
            UPDATE worker_enrollments
            SET status = 'revoked', revoked_at = NOW()
            WHERE worker_id = $1 AND namespace = $2 AND status = 'active'
              AND ($4::boolean OR ($3::text IS NOT NULL AND user_id = $3))
            """,
        worker_id, namespace, user_id, allow_other_users,
    )
    return result.endswith(" 1")
