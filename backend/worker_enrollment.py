"""Persistent Worker enrollment for the single public Worker cluster.

The raw Worker credential is returned only when it is issued and the database
stores only its digest. Namespace, pool, provider, and execution capability
are server-owned; a browser cannot select them. All compatible Workers join the
same public PostgreSQL/Redis cluster, with independent revocable credentials.

The legacy ``trust_level`` storage field is retained only for schema migration
compatibility and is forced to the same public execution policy for every new
credential. It is not an authorization input or a capability branch.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone


TRUST_GENERAL = "general"
TRUST_FULL = "full"
TRUST_LEVELS = frozenset({TRUST_GENERAL, TRUST_FULL})


class WorkerEnrollmentError(RuntimeError):
    """A Worker cannot be enrolled or authenticated."""


class DuplicateWorkerError(WorkerEnrollmentError):
    """The requested Worker ID already has an active credential."""


class WorkerOwnershipError(WorkerEnrollmentError):
    """A revoked Worker ID cannot be transferred between accounts silently."""


def normalize_trust_level(value: str | None) -> str:
    """Normalize a legacy field to the one public execution policy.

    Existing rows may still contain the old labels while the database migrates.
    New authentication and issuance never use this value to grant capabilities.
    """
    normalized = str(value or TRUST_GENERAL).strip().lower()
    return TRUST_GENERAL if normalized in TRUST_LEVELS else TRUST_GENERAL


@dataclass(frozen=True)
class EnrollmentToken:
    worker_id: str
    namespace: str
    token: str
    expires_at: str
    owner_user_id: str | None = None
    trust_level: str = TRUST_GENERAL


@dataclass(frozen=True)
class WorkerCredential:
    worker_id: str
    namespace: str
    credential: str
    owner_user_id: str | None = None
    trust_level: str = TRUST_GENERAL


@dataclass(frozen=True)
class WorkerIdentity:
    worker_id: str
    namespace: str
    owner_user_id: str | None
    trust_level: str


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


def _safe_owner_user_id(value: str | None) -> str | None:
    owner = str(value or "").strip()
    if not owner:
        return None
    if len(owner) > 255 or any(ch.isspace() for ch in owner):
        raise WorkerEnrollmentError("invalid Worker owner")
    return owner


def _row_value(row, key: str, default=None):
    try:
        return row[key]
    except (KeyError, IndexError, TypeError, AttributeError):
        return default


async def _lock_owner_namespace(conn, owner_user_id: str | None) -> None:
    """Serialize enrollment changes that establish an account Namespace.

    A query-then-insert check is not enough when two Workers are signed at the
    same time. Transaction-scoped advisory locking makes the Namespace check
    and the subsequent enrollment write one serialized account operation while
    keeping the schema compatible with existing rows.
    """
    if owner_user_id:
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            owner_user_id,
        )


def _rls_is_expected() -> bool:
    configured = os.getenv("DB_RLS_ENABLED")
    if configured is not None:
        return configured.strip().lower() not in {"0", "false", "no", "off"}
    return os.getenv("APP_ENV", "development").lower() in {"acceptance", "production", "prod"}


async def _persist_worker_enrollment(
    conn,
    *,
    worker_id: str,
    namespace: str,
    credential: str,
    owner_user_id: str | None,
    trust_level: str,
    trust_issuer_connection: bool = False,
) -> None:
    """Persist enrollment through the protected issuer on RLS databases.

    The ordinary API role has no direct trust-level DML privilege after the
    RLS migration.  Development databases without that operator migration
    retain the legacy direct path so local smoke tests remain usable.
    """
    digest = credential_digest(credential)
    if _rls_is_expected():
        if trust_level == TRUST_FULL:
            # Full trust is a database-role capability, not a caller-supplied
            # function argument. Acceptance/production uses a dedicated raw
            # trust-issuer login; the ordinary API login cannot SET ROLE into
            # this NOLOGIN role.
            if _rls_is_expected() and not trust_issuer_connection:
                raise RuntimeError("dedicated trust issuer connection is required")
            await conn.execute(
                "SELECT app.issue_full_worker_enrollment($1, $2, $3, $4)",
                worker_id, digest, namespace, owner_user_id,
            )
        else:
            await conn.execute(
                "SELECT app.issue_worker_enrollment($1, $2, $3, $4)",
                worker_id, digest, namespace, owner_user_id,
            )
        return
    await conn.execute(
        """
        INSERT INTO worker_enrollments (
            worker_id, credential_hash, namespace, owner_user_id, trust_level,
            status, last_seen_at
        ) VALUES ($1, $2, $3, $4, $5, 'active', NOW())
        ON CONFLICT (worker_id) DO UPDATE SET
            credential_hash = EXCLUDED.credential_hash,
            namespace = EXCLUDED.namespace,
            owner_user_id = COALESCE(EXCLUDED.owner_user_id, worker_enrollments.owner_user_id),
            trust_level = EXCLUDED.trust_level,
            status = 'active',
            enrolled_at = NOW(),
            revoked_at = NULL,
            last_seen_at = NOW()
        """,
        worker_id, digest, namespace, owner_user_id, trust_level,
    )


async def issue_enrollment_token(
    pool,
    worker_id: str,
    namespace: str,
    *,
    ttl_seconds: int = 600,
    owner_user_id: str | None = None,
    trust_level: str = TRUST_GENERAL,
) -> EnrollmentToken:
    """Issue an optional one-time bootstrap token with fixed server policy."""
    worker_id = _safe_worker_id(worker_id)
    namespace = _safe_namespace(namespace)
    owner_user_id = _safe_owner_user_id(owner_user_id)
    trust_level = normalize_trust_level(trust_level)
    if ttl_seconds < 30 or ttl_seconds > 3600:
        raise WorkerEnrollmentError("enrollment token TTL is outside the local safety range")
    raw = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds)
    async with pool.acquire() as conn:
        if _rls_is_expected():
            # The compatibility bootstrap token is always general trust on an
            # RLS database.  Full trust is issued only through the persistent
            # credential path and the dedicated trust-issuer role.
            await conn.execute(
                """
                INSERT INTO worker_enrollment_tokens (
                    token_hash, worker_id, namespace, owner_user_id, expires_at
                ) VALUES ($1, $2, $3, $4, $5)
                """,
                credential_digest(raw), worker_id, namespace, owner_user_id, expires,
            )
        else:
            await conn.execute(
                """
                INSERT INTO worker_enrollment_tokens (
                    token_hash, worker_id, namespace, owner_user_id, trust_level, expires_at
                ) VALUES ($1, $2, $3, $4, $5, $6)
                """,
                credential_digest(raw), worker_id, namespace, owner_user_id, trust_level, expires,
            )
    return EnrollmentToken(worker_id, namespace, raw, expires.isoformat(), owner_user_id, trust_level)


async def issue_worker_credential(
    pool,
    worker_id: str,
    namespace: str,
    *,
    owner_user_id: str | None = None,
    trust_level: str = TRUST_GENERAL,
    trust_issuer_pool=None,
) -> WorkerCredential:
    """Create a persistent credential for one globally unique Worker ID.

    Re-enrolling a revoked Worker rotates its credential and refreshes the
    server-derived trust.  An active Worker must be revoked explicitly first.
    A revoked Worker cannot silently move to another account.
    """
    worker_id = _safe_worker_id(worker_id)
    namespace = _safe_namespace(namespace)
    owner_user_id = _safe_owner_user_id(owner_user_id)
    trust_level = normalize_trust_level(trust_level)
    credential = secrets.token_urlsafe(32)
    if trust_level == TRUST_FULL and _rls_is_expected() and trust_issuer_pool is None:
        raise RuntimeError("dedicated trust issuer pool is required")
    if trust_level == TRUST_FULL and trust_issuer_pool is not None:
        # The trust issuer function enforces the owner binding from this
        # transaction-local identity; no user GUC is left on the raw pool.
        async with trust_issuer_pool.acquire() as trust_conn:
            async with trust_conn.transaction():
                from backend.db_rls import user_context_proof
                await trust_conn.execute(
                    "SELECT set_config('app.user_id', $1, true)",
                    owner_user_id or "",
                )
                await trust_conn.execute(
                    "SELECT set_config('app.user_proof', $1, true)",
                    user_context_proof(owner_user_id or ""),
                )
                await _persist_worker_enrollment(
                    trust_conn,
                    worker_id=worker_id,
                    namespace=namespace,
                    credential=credential,
                    owner_user_id=owner_user_id,
                    trust_level=trust_level,
                    trust_issuer_connection=True,
                )
        return WorkerCredential(worker_id, namespace, credential, owner_user_id, trust_level)

    async with pool.acquire() as conn:
        async with conn.transaction():
            await _lock_owner_namespace(conn, owner_user_id)
            existing = await conn.fetchrow(
                """
                SELECT worker_id, owner_user_id, status, revoked_at FROM worker_enrollments
                WHERE worker_id = $1
                FOR UPDATE
                """,
                worker_id,
            )
            if existing and existing["status"] == "active" and existing["revoked_at"] is None:
                raise DuplicateWorkerError("worker ID already has an active enrollment")
            existing_owner = _safe_owner_user_id(_row_value(existing, "owner_user_id")) if existing else None
            if existing_owner and owner_user_id and existing_owner != owner_user_id:
                raise WorkerOwnershipError("worker ID belongs to another account")
            if owner_user_id:
                account_namespace = await conn.fetchrow(
                    """
                    SELECT namespace
                    FROM worker_enrollments
                    WHERE owner_user_id = $1
                      AND status = 'active'
                      AND namespace IS DISTINCT FROM $2
                    LIMIT 1
                    """,
                    owner_user_id,
                    namespace,
                )
                if account_namespace:
                    raise WorkerOwnershipError("account is already bound to another Worker Namespace")
            await _persist_worker_enrollment(
                conn,
                worker_id=worker_id,
                namespace=namespace,
                credential=credential,
                owner_user_id=owner_user_id,
                trust_level=trust_level,
            )
    return WorkerCredential(worker_id, namespace, credential, owner_user_id, trust_level)


async def complete_enrollment(pool, worker_id: str, namespace: str, token: str) -> str:
    """Consume a one-time token and return a persistent per-Worker credential."""
    worker_id = _safe_worker_id(worker_id)
    namespace = _safe_namespace(namespace)
    token_hash = credential_digest(token)
    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                """
                SELECT token_hash, worker_id, namespace, owner_user_id, trust_level,
                       expires_at, used_at
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
            owner_user_id = _safe_owner_user_id(_row_value(row, "owner_user_id"))
            trust_level = normalize_trust_level(_row_value(row, "trust_level", TRUST_GENERAL))
            await _lock_owner_namespace(conn, owner_user_id)
            existing = await conn.fetchrow(
                """
                SELECT worker_id, owner_user_id, status, revoked_at FROM worker_enrollments
                WHERE worker_id = $1
                FOR UPDATE
                """,
                worker_id,
            )
            if existing and existing["status"] == "active" and existing["revoked_at"] is None:
                raise DuplicateWorkerError("worker ID already has an active enrollment")
            existing_owner = _safe_owner_user_id(_row_value(existing, "owner_user_id")) if existing else None
            if existing_owner and owner_user_id and existing_owner != owner_user_id:
                raise WorkerOwnershipError("worker ID belongs to another account")
            credential = secrets.token_urlsafe(32)
            await conn.execute(
                "UPDATE worker_enrollment_tokens SET used_at = NOW() WHERE token_hash = $1",
                token_hash,
            )
            await _persist_worker_enrollment(
                conn,
                worker_id=worker_id,
                namespace=namespace,
                credential=credential,
                owner_user_id=owner_user_id,
                trust_level=trust_level,
            )
            return credential


async def authenticate_worker_identity(
    pool,
    worker_id: str,
    namespace: str,
    credential: str,
) -> WorkerIdentity | None:
    """Validate a credential and return only server-stored Worker policy."""
    worker_id = _safe_worker_id(worker_id)
    namespace = _safe_namespace(namespace)
    supplied = credential_digest(credential)
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT owner_user_id, trust_level, credential_hash
            FROM worker_enrollments
            WHERE worker_id = $1 AND namespace = $2
              AND status = 'active' AND revoked_at IS NULL
            """,
            worker_id, namespace,
        )
        if not row or not hmac.compare_digest(str(row["credential_hash"]), supplied):
            return None
        await conn.execute(
            """
            UPDATE worker_enrollments SET last_seen_at = NOW()
            WHERE worker_id = $1 AND namespace = $2
              AND status = 'active' AND revoked_at IS NULL
            """,
            worker_id, namespace,
        )
    return WorkerIdentity(
        worker_id=worker_id,
        namespace=namespace,
        owner_user_id=_safe_owner_user_id(_row_value(row, "owner_user_id")),
        trust_level=normalize_trust_level(_row_value(row, "trust_level", TRUST_GENERAL)),
    )


async def authenticate_worker(pool, worker_id: str, namespace: str, credential: str) -> bool:
    """Compatibility boolean wrapper for callers that only need validity."""
    return await authenticate_worker_identity(pool, worker_id, namespace, credential) is not None


async def revoke_worker(pool, worker_id: str, namespace: str, *, operator_pool=None) -> bool:
    worker_id = _safe_worker_id(worker_id)
    namespace = _safe_namespace(namespace)
    persistence_pool = operator_pool if _rls_is_expected() and operator_pool is not None else pool
    async with persistence_pool.acquire() as conn:
        if _rls_is_expected() and hasattr(conn, "fetchval"):
            return bool(await conn.fetchval(
                "SELECT app.revoke_worker_enrollment($1, $2)",
                worker_id,
                namespace,
            ))
        result = await conn.execute(
            """
            UPDATE worker_enrollments
            SET status = 'revoked', revoked_at = NOW()
            WHERE worker_id = $1 AND namespace = $2 AND status = 'active'
            """,
            worker_id, namespace,
        )
    return result.endswith(" 1")
