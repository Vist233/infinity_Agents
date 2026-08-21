"""Minimal admin CLI for the pure-local runtime (no Cloudflare dependency).

Usage examples:
    python -m backend.local_runtime.admin issue-worker --worker-id worker-public --created-by admin
    python -m backend.local_runtime.admin put-resource --owner alice --kind dataset --file data.csv
    python -m backend.local_runtime.admin create-task --created-by alice --title Run --goal "..." \
        --dataset <resource-id>
    python -m backend.local_runtime.admin show-task --task-id <task-id>
    python -m backend.local_runtime.admin download-artifact --task-id <task-id> --out result.zip

Requires LOCAL_RUNTIME_DATABASE_URL and LOCAL_OBJECT_ROOT in the environment.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import secrets
import uuid

import asyncpg

from .migrations import apply_migrations
from .object_store import LocalObjectStore
from .repository import LocalRuntimeRepository


def _database_url() -> str:
    value = os.getenv("LOCAL_RUNTIME_DATABASE_URL", "").strip()
    if not value:
        raise SystemExit("LOCAL_RUNTIME_DATABASE_URL is required")
    return value


def _store() -> LocalObjectStore:
    root = os.getenv("LOCAL_OBJECT_ROOT", "").strip()
    if not root:
        raise SystemExit("LOCAL_OBJECT_ROOT is required")
    return LocalObjectStore(root)


async def _pool() -> asyncpg.Pool:
    database_url = _database_url()
    await apply_migrations(database_url)
    return await asyncpg.create_pool(database_url, min_size=1, max_size=4)


async def cmd_issue_worker(args: argparse.Namespace) -> None:
    credential = args.credential or secrets.token_urlsafe(32)
    pool = await _pool()
    try:
        repository = LocalRuntimeRepository(pool)
        await repository.issue_worker(
            worker_id=args.worker_id,
            created_by=args.created_by,
            credential=credential,
            image_digest=args.image_digest or None,
        )
    finally:
        await pool.close()
    print(json.dumps({"worker_id": args.worker_id, "credential": credential}))


async def cmd_put_resource(args: argparse.Namespace) -> None:
    data = os.path.abspath(args.file)
    with open(data, "rb") as handle:
        payload = handle.read()
    sha256 = hashlib.sha256(payload).hexdigest()
    object_key = f"inputs/{args.kind}/{uuid.uuid4()}/{os.path.basename(args.file)}"
    store = _store()
    size, digest = store.write_bytes(object_key, payload)
    assert digest == sha256
    pool = await _pool()
    try:
        resource_id = await pool.fetchval(
            """
            INSERT INTO infinity_runtime.resources
                (owner_user_id, kind, logical_name, object_key, content_type,
                 file_size_bytes, checksum_sha256, state)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'ready')
            RETURNING resource_id
            """,
            args.owner, args.kind, args.logical_name or os.path.basename(args.file),
            object_key, args.content_type, size, sha256,
        )
    finally:
        await pool.close()
    print(json.dumps({"resource_id": str(resource_id), "object_key": object_key,
                      "file_size_bytes": size, "checksum_sha256": sha256}))


async def cmd_create_task(args: argparse.Namespace) -> None:
    execution_document = json.loads(args.execution_document) if args.execution_document else {}
    pool = await _pool()
    try:
        repository = LocalRuntimeRepository(pool)
        task_id = await repository.create_task(
            created_by=args.created_by,
            title=args.title,
            goal=args.goal,
            execution_document=execution_document,
            dataset_resource_id=uuid.UUID(args.dataset),
            method_resource_id=uuid.UUID(args.method) if args.method else None,
        )
    finally:
        await pool.close()
    print(json.dumps({"task_id": str(task_id), "status": "queued"}))


async def cmd_show_task(args: argparse.Namespace) -> None:
    pool = await _pool()
    try:
        row = await pool.fetchrow(
            """
            SELECT t.task_id, t.status, t.attempt_count, t.error_code, t.error_detail,
                   a.object_key AS artifact_object_key, a.name AS artifact_name
            FROM infinity_runtime.tasks t
            LEFT JOIN infinity_runtime.artifacts a ON a.artifact_id = t.result_artifact_id
            WHERE t.task_id = $1
            """,
            uuid.UUID(args.task_id),
        )
    finally:
        await pool.close()
    if not row:
        raise SystemExit("task not found")
    print(json.dumps({key: str(value) if value is not None else None for key, value in dict(row).items()}))


async def cmd_download_artifact(args: argparse.Namespace) -> None:
    pool = await _pool()
    try:
        object_key = await pool.fetchval(
            """
            SELECT a.object_key
            FROM infinity_runtime.tasks t
            JOIN infinity_runtime.artifacts a ON a.artifact_id = t.result_artifact_id
            WHERE t.task_id = $1 AND t.status = 'succeeded'
            """,
            uuid.UUID(args.task_id),
        )
    finally:
        await pool.close()
    if not object_key:
        raise SystemExit("no published artifact for this task")
    source = _store().read_path(object_key)
    destination = os.path.abspath(args.out)
    with open(source, "rb") as reader, open(destination, "wb") as writer:
        while True:
            chunk = reader.read(1024 * 1024)
            if not chunk:
                break
            writer.write(chunk)
    print(json.dumps({"object_key": object_key, "downloaded_to": destination}))


def main() -> None:
    parser = argparse.ArgumentParser(prog="backend.local_runtime.admin")
    sub = parser.add_subparsers(dest="command", required=True)

    issue = sub.add_parser("issue-worker")
    issue.add_argument("--worker-id", required=True)
    issue.add_argument("--created-by", required=True)
    issue.add_argument("--credential", default="")
    issue.add_argument("--image-digest", default="")

    put = sub.add_parser("put-resource")
    put.add_argument("--owner", required=True)
    put.add_argument("--kind", required=True, choices=["dataset", "method"])
    put.add_argument("--file", required=True)
    put.add_argument("--logical-name", default="")
    put.add_argument("--content-type", default="application/octet-stream")

    create = sub.add_parser("create-task")
    create.add_argument("--created-by", required=True)
    create.add_argument("--title", required=True)
    create.add_argument("--goal", required=True)
    create.add_argument("--execution-document", default="")
    create.add_argument("--dataset", required=True)
    create.add_argument("--method", default="")

    show = sub.add_parser("show-task")
    show.add_argument("--task-id", required=True)

    download = sub.add_parser("download-artifact")
    download.add_argument("--task-id", required=True)
    download.add_argument("--out", required=True)

    args = parser.parse_args()
    handlers = {
        "issue-worker": cmd_issue_worker,
        "put-resource": cmd_put_resource,
        "create-task": cmd_create_task,
        "show-task": cmd_show_task,
        "download-artifact": cmd_download_artifact,
    }
    asyncio.run(handlers[args.command](args))


if __name__ == "__main__":
    main()
