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
WORKER_PROTOCOL_VERSION = "1"
WORKER_RUNTIME_CAPABILITY = "goal-driven-claude-code"
WORKER_EXECUTION_POOL = "public-default"


class WorkerEnrollmentError(RuntimeError):
    """A Worker cannot be enrolled or authenticated."""


class DuplicateWorkerError(WorkerEnrollmentError):
    """The requested Worker ID already has an active credential."""


class WorkerOwnershipError(WorkerEnrollmentError):
    """A revoked Worker ID cannot be transferred between accounts silently."""


class WorkerProtocolError(WorkerEnrollmentError):
    """The Worker runtime is not compatible with the active server protocol."""


class ActiveWorkerInstanceError(WorkerEnrollmentError):
    """A credential is already held by another live Worker process."""


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
    execution_pool: str = WORKER_EXECUTION_POOL


@dataclass(frozen=True)
class WorkerIdentity:
    worker_id: str
    namespace: str
    owner_user_id: str | None
    trust_level: str
    execution_pool: str = WORKER_EXECUTION_POOL
    protocol_version: str = "legacy-v0"
    runtime_capability: str = "legacy"
    image_digest: str | None = None
    active_instance_id: str | None = None
    ready: bool = False
    session_epoch: int = 0


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


def _safe_instance_id(value: str | None) -> str:
    instance_id = str(value or "").strip()
    if not instance_id or len(instance_id) > 128 or any(ch.isspace() for ch in instance_id):
        raise WorkerProtocolError("invalid Worker instance ID")
    return instance_id


def expected_worker_protocol() -> str:
    return os.getenv("WORKER_PROTOCOL_VERSION", WORKER_PROTOCOL_VERSION).strip() or WORKER_PROTOCOL_VERSION


def expected_worker_runtime_capability() -> str:
    return os.getenv("WORKER_RUNTIME_CAPABILITY", WORKER_RUNTIME_CAPABILITY).strip() or WORKER_RUNTIME_CAPABILITY


def worker_session_ttl_seconds() -> int:
    try:
        value = int(os.getenv("WORKER_SESSION_TTL_SECONDS", "90"))
    except ValueError:
        value = 90
    return max(30, min(value, 3600))


def _identity_from_row(worker_id: str, namespace: str, row) -> WorkerIdentity:
    raw_epoch = _row_value(row, "session_epoch", 0)
    try:
        epoch = int(raw_epoch or 0)
    except (TypeError, ValueError):
        epoch = 0
    return WorkerIdentity(
        worker_id=worker_id,
        namespace=namespace,
        owner_user_id=_safe_owner_user_id(_row_value(row, "owner_user_id")),
        trust_level=normalize_trust_level(_row_value(row, "trust_level", TRUST_GENERAL)),
        execution_pool=str(_row_value(row, "execution_pool", WORKER_EXECUTION_POOL) or WORKER_EXECUTION_POOL),
        protocol_version=str(_row_value(row, "protocol_version", "legacy-v0") or "legacy-v0"),
        runtime_capability=str(_row_value(row, "runtime_capability", "legacy") or "legacy"),
        image_digest=str(_row_value(row, "image_digest")) if _row_value(row, "image_digest") else None,
        active_instance_id=str(_row_value(row, "active_instance_id")) if _row_value(row, "active_instance_id") else None,
        ready=bool(_row_value(row, "ready", False)),
        session_epoch=epoch,
    )


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
    execution_pool: str | None = None,
    trust_issuer_connection: bool = False,
) -> None:
    """Persist enrollment through the protected issuer on RLS databases.

    The ordinary API role has no direct trust-level DML privilege after the
    RLS migration.  Development databases without that operator migration
    retain the legacy direct path so local smoke tests remain usable.
    """
    digest = credential_digest(credential)
    if _rls_is_expected():
        if execution_pool == WORKER_EXECUTION_POOL and trust_level != TRUST_FULL:
            # Public-pool issuance is a distinct database capability. It keeps
            # the human audit owner while deliberately not binding scheduling
            # to that owner or to a user-selected Namespace.
            await conn.execute(
                "SELECT app.issue_public_worker_enrollment($1, $2, $3, $4)",
                worker_id, digest, namespace, owner_user_id,
            )
            return
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
            worker_id, credential_hash, namespace, owner_user_id, execution_pool, trust_level,
            status, last_seen_at
        ) VALUES ($1, $2, $3, $4, COALESCE($6, 'public-default'), $5, 'active', NOW())
        ON CONFLICT (worker_id) DO UPDATE SET
            credential_hash = EXCLUDED.credential_hash,
            namespace = EXCLUDED.namespace,
            owner_user_id = COALESCE(EXCLUDED.owner_user_id, worker_enrollments.owner_user_id),
            execution_pool = EXCLUDED.execution_pool,
            trust_level = EXCLUDED.trust_level,
            status = 'active',
            enrolled_at = NOW(),
            revoked_at = NULL,
            last_seen_at = NOW()
        """,
        worker_id, digest, namespace, owner_user_id, trust_level, execution_pool,
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
    execution_pool: str = WORKER_EXECUTION_POOL,
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
                    execution_pool=execution_pool,
                    trust_issuer_connection=True,
                )
        return WorkerCredential(worker_id, namespace, credential, owner_user_id, trust_level, execution_pool)

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
                execution_pool=execution_pool,
            )
    return WorkerCredential(worker_id, namespace, credential, owner_user_id, trust_level, execution_pool)


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
    *,
    instance_id: str | None = None,
    protocol_version: str | None = None,
    runtime_capability: str | None = None,
    image_digest: str | None = None,
    ready: bool = False,
) -> WorkerIdentity | None:
    """Validate a credential and return only server-stored Worker policy.

    Supplying session fields performs the protocol/instance handshake.  The
    no-session form remains only for compatibility with administrative status
    checks; data-plane Workers must use the session form so one credential
    cannot be live in two containers at once.
    """
    if instance_id is not None:
        return await authenticate_worker_session(
            pool,
            worker_id,
            namespace,
            credential,
            instance_id=instance_id,
            protocol_version=protocol_version or "",
            runtime_capability=runtime_capability or "",
            image_digest=image_digest,
            ready=ready,
        )
    worker_id = _safe_worker_id(worker_id)
    namespace = _safe_namespace(namespace)
    supplied = credential_digest(credential)
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT owner_user_id, trust_level, execution_pool,
                   protocol_version, runtime_capability, image_digest,
                   active_instance_id, ready, session_epoch, credential_hash
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
    return _identity_from_row(worker_id, namespace, row)


async def authenticate_worker_session(
    pool,
    worker_id: str,
    namespace: str,
    credential: str,
    *,
    instance_id: str,
    protocol_version: str,
    runtime_capability: str,
    image_digest: str | None = None,
    ready: bool = False,
) -> WorkerIdentity | None:
    """Atomically authenticate and fence one long-lived Worker instance."""
    worker_id = _safe_worker_id(worker_id)
    namespace = _safe_namespace(namespace)
    instance_id = _safe_instance_id(instance_id)
    supplied_protocol = str(protocol_version or "").strip()
    supplied_runtime = str(runtime_capability or "").strip()
    supplied_digest = str(image_digest or "").strip() or None
    if supplied_protocol != expected_worker_protocol():
        raise WorkerProtocolError("Worker protocol is incompatible")
    if supplied_runtime != expected_worker_runtime_capability():
        raise WorkerProtocolError("Worker runtime capability is incompatible")
    expected_digest = os.getenv("WORKER_IMAGE_DIGEST", "").strip()
    if expected_digest and supplied_digest != expected_digest:
        raise WorkerProtocolError("Worker image digest is incompatible")

    supplied = credential_digest(credential)
    now = datetime.now(timezone.utc)
    expiry = now + timedelta(seconds=worker_session_ttl_seconds())
    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                """
                SELECT owner_user_id, trust_level, execution_pool,
                       protocol_version, runtime_capability, image_digest,
                       active_instance_id, active_instance_expires_at,
                       ready, session_epoch, credential_hash
                FROM worker_enrollments
                WHERE worker_id = $1 AND namespace = $2
                  AND status = 'active' AND revoked_at IS NULL
                FOR UPDATE
                """,
                worker_id,
                namespace,
            )
            if not row or not hmac.compare_digest(str(_row_value(row, "credential_hash", "")), supplied):
                return None
            current_instance = str(_row_value(row, "active_instance_id") or "").strip()
            current_expiry = _row_value(row, "active_instance_expires_at")
            live_other_instance = bool(
                current_instance
                and current_instance != instance_id
                and current_expiry is not None
                and current_expiry > now
            )
            if live_other_instance:
                raise ActiveWorkerInstanceError("Worker credential is already connected by another instance")
            try:
                current_epoch = int(_row_value(row, "session_epoch", 0) or 0)
            except (TypeError, ValueError):
                current_epoch = 0
            next_epoch = current_epoch if current_instance == instance_id and current_expiry and current_expiry > now else current_epoch + 1
            await conn.execute(
                """
                UPDATE worker_enrollments
                SET protocol_version = $3,
                    runtime_capability = $4,
                    image_digest = $5,
                    active_instance_id = $6,
                    active_instance_expires_at = $7,
                    session_epoch = $8,
                    ready = $9,
                    last_error = NULL,
                    connected_at = COALESCE(connected_at, NOW()),
                    last_seen_at = NOW()
                WHERE worker_id = $1 AND namespace = $2
                  AND status = 'active' AND revoked_at IS NULL
                """,
                worker_id,
                namespace,
                supplied_protocol,
                supplied_runtime,
                supplied_digest,
                instance_id,
                expiry,
                next_epoch,
                bool(ready),
            )
            if not await conn.fetchrow(
                """
                SELECT worker_id
                FROM worker_enrollments
                WHERE worker_id = $1 AND namespace = $2
                  AND active_instance_id = $3 AND session_epoch = $4
                  AND status = 'active' AND revoked_at IS NULL
                """,
                worker_id,
                namespace,
                instance_id,
                next_epoch,
            ):
                raise WorkerEnrollmentError("Worker session could not be fenced")
            row = dict(row)
            row.update({
                "execution_pool": _row_value(row, "execution_pool", WORKER_EXECUTION_POOL),
                "protocol_version": supplied_protocol,
                "runtime_capability": supplied_runtime,
                "image_digest": supplied_digest,
                "active_instance_id": instance_id,
                "ready": bool(ready),
                "session_epoch": next_epoch,
            })
    return _identity_from_row(worker_id, namespace, row)


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
            SET status = 'revoked', revoked_at = NOW(), ready = FALSE,
                active_instance_id = NULL, active_instance_expires_at = NULL,
                last_error = 'Worker credential revoked'
            WHERE worker_id = $1 AND namespace = $2 AND status = 'active'
            """,
            worker_id, namespace,
        )
    return result.endswith(" 1")
