"""Long-lived D1 Worker v2 process.

The process owns one persistent Worker credential. It connects to the
Cloudflare control plane, uses the HTTPS Redis Relay only for wake-up hints,
claims work with D1 fencing, runs direct non-root Claude Code, uploads the
result, and then clears the attempt directory.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
from typing import Any

from backend.code_agent.worker.control_plane import ControlPlaneError, RedisHintClient, WorkerV2Client
from backend.code_agent.worker.executor_v2 import execute_claim

logger = logging.getLogger(__name__)


def _required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise SystemExit(f"{name} is required")
    return value


async def _heartbeat(client: WorkerV2Client, stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=25.0)
            continue
        except asyncio.TimeoutError:
            pass
        try:
            await client.heartbeat()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("Worker heartbeat failed: %s", type(exc).__name__)


async def run_worker(worker_id: str) -> None:
    control_plane_url = _required("WORKER_CONTROL_PLANE_URL")
    relay_url = _required("WORKER_RELAY_URL")
    credential = _required("WORKER_CREDENTIAL")
    instance_id = _required("WORKER_INSTANCE_ID")
    relay_token = _required("WORKER_RELAY_HINT_TOKEN")
    image_digest = os.getenv("WORKER_IMAGE_DIGEST", "").strip() or None
    client = WorkerV2Client(
        base_url=control_plane_url,
        worker_id=worker_id,
        credential=credential,
        instance_id=instance_id,
        image_digest=image_digest,
    )
    relay = RedisHintClient(base_url=relay_url, token=relay_token)
    stop = asyncio.Event()
    heartbeat_task: asyncio.Task[Any] | None = None
    try:
        await client.connect()
        heartbeat_task = asyncio.create_task(_heartbeat(client, stop))
        while not stop.is_set():
            try:
                # Hints are advisory only. D1 poll/claim is authoritative, so
                # a Relay outage cannot lose or duplicate a task.
                hints = await relay.read(limit=20)
                if hints:
                    logger.info("Worker %s received %d task hint(s)", worker_id, len(hints))
            except Exception as exc:
                logger.warning("Redis Relay hint read failed: %s", type(exc).__name__)

            try:
                tasks, next_poll_seconds = await client.poll()
            except ControlPlaneError as exc:
                if exc.code in {"WORKER_SESSION_INVALID", "WORKER_SESSION_STALE", "WORKER_AUTH_INVALID", "WORKER_ALREADY_CONNECTED"}:
                    raise
                logger.warning("D1 Worker poll failed: %s", exc.code or type(exc).__name__)
                await asyncio.sleep(5)
                continue

            if not tasks:
                await asyncio.sleep(0 if hints else next_poll_seconds)
                continue
            for task in tasks:
                try:
                    claim = await client.accept(task)
                except ControlPlaneError as exc:
                    if exc.code not in {"TASK_NOT_AVAILABLE", "TASK_CLAIM_CONFLICT"}:
                        logger.warning("Worker claim failed: %s", exc.code or type(exc).__name__)
                    continue
                result = await execute_claim(client, claim)
                if result.get("success"):
                    logger.info("Worker %s completed task %s", worker_id, claim.task_id)
                else:
                    logger.warning("Worker %s failed task %s", worker_id, claim.task_id)
    finally:
        stop.set()
        if heartbeat_task:
            heartbeat_task.cancel()
            try:
                await heartbeat_task
            except asyncio.CancelledError:
                pass
        await relay.close()
        await client.close()


async def _main(worker_id: str) -> None:
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
    await run_worker(worker_id)


if __name__ == "__main__":
    asyncio.run(_main(sys.argv[1] if len(sys.argv) > 1 else os.getenv("WORKER_ID", "")))
