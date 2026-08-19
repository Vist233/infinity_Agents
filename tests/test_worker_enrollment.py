from __future__ import annotations

import pytest

import backend.app as app_module
from backend.auth import Principal
from backend.worker_enrollment import (
    DuplicateWorkerError,
    authenticate_worker_identity,
    credential_digest,
    issue_worker_credential,
)


class _Transaction:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None


class _Conn:
    def __init__(self, existing=None):
        self.existing = existing
        self.queries = []

    def transaction(self):
        return _Transaction()

    async def fetchrow(self, query, *args):
        if "FROM worker_enrollments" in query:
            return self.existing
        return None

    async def execute(self, query, *args):
        self.queries.append((query, args))
        return "OK 1"


class _Pool:
    def __init__(self, conn):
        self.conn = conn

    def acquire(self):
        pool = self

        class _Acquire:
            async def __aenter__(self):
                return pool.conn

            async def __aexit__(self, *args):
                return None

        return _Acquire()


@pytest.mark.asyncio
async def test_worker_credential_is_persistent_and_only_digest_is_written():
    conn = _Conn()
    result = await issue_worker_credential(_Pool(conn), "mac-01", "cluster-a")

    assert result.worker_id == "mac-01"
    assert result.namespace == "cluster-a"
    assert result.credential
    insert = next((args for query, args in conn.queries if "INSERT INTO worker_enrollments" in query), None)
    assert insert is not None
    assert insert[1] == credential_digest(result.credential)
    assert result.credential not in str(insert)


@pytest.mark.asyncio
async def test_active_worker_id_cannot_be_issued_twice():
    conn = _Conn({"worker_id": "mac-01", "status": "active", "revoked_at": None})
    with pytest.raises(DuplicateWorkerError):
        await issue_worker_credential(_Pool(conn), "mac-01", "cluster-b")


@pytest.mark.asyncio
async def test_worker_identity_returns_server_assigned_owner_without_client_policy():
    conn = _Conn({
        "credential_hash": credential_digest("worker-secret"),
        "owner_user_id": "alice",
        "status": "active",
        "revoked_at": None,
    })
    identity = await authenticate_worker_identity(_Pool(conn), "mac-01", "cluster-a", "worker-secret")

    assert identity is not None
    assert identity.owner_user_id == "alice"
    assert any("last_seen_at" in query for query, _args in conn.queries)


@pytest.mark.asyncio
async def test_legacy_full_label_does_not_create_a_second_execution_policy():
    conn = _Conn({
        "credential_hash": credential_digest("worker-secret"),
        "owner_user_id": "alice",
        "trust_level": "full",
        "execution_pool": "public-default",
        "status": "active",
        "revoked_at": None,
    })
    identity = await authenticate_worker_identity(_Pool(conn), "mac-01", "cluster-a", "worker-secret")

    assert identity is not None
    assert identity.trust_level == "general"
    assert identity.execution_pool == "public-default"


def test_acceptance_worker_enrollment_requires_explicit_operator(monkeypatch):
    user = Principal(user_id="student")
    monkeypatch.setenv("APP_ENV", "acceptance")
    monkeypatch.setenv("WORKER_ENROLLMENT_ADMIN_USER_IDS", "operator")
    assert app_module._worker_enrollment_admin_allowed(user) is False
    assert app_module._worker_enrollment_admin_allowed(Principal(user_id="operator")) is True


def test_public_worker_namespace_is_server_owned(monkeypatch):
    monkeypatch.setenv("WORKER_PUBLIC_NAMESPACE", "infinity-public")
    assert app_module._public_worker_namespace() == "infinity-public"
