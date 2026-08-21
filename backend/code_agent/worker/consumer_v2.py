"""Long-lived Worker v2 process.

The process owns one persistent Worker credential. It connects to the
control plane API, optionally reads wake-up hints from a Redis Relay,
claims work with fencing, runs direct non-root Claude Code, uploads the
result, and then clears the attempt directory.

When WORKER_RELAY_URL is not set the Worker relies solely on control-plane
polling for task discovery (hints are advisory and their absence does not
affect correctness).
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
from typing import Any

import httpx

from backend.code_agent.worker.control_plane import ControlPlaneError, RedisHintClient, WorkerV2Client
from backend.code_agent.worker.executor_v2 import execute_claim

logger = logging.getLogger(__name__)


def _required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise SystemExit(f"{name} is required")
    return value


_SESSION_RECONNECT_CODES = {"WORKER_SESSION_INVALID", "WORKER_SESSION_STALE"}
_FATAL_CONNECT_CODES = {"WORKER_AUTH_INVALID", "WORKER_ALREADY_CONNECTED"}


def _retry_delay() -> float:
    try:
        value = float(os.getenv("WORKER_RETRY_DELAY_SECONDS", "5"))
    except ValueError:
        value = 5.0
    return max(0.0, min(value, 60.0))


def _is_transient_transport_error(exc: BaseException) -> bool:
    return isinstance(exc, (httpx.HTTPError, OSError, asyncio.TimeoutError))


async def _retry_pause() -> None:
    await asyncio.sleep(_retry_delay())


async def _connect_until_ready(client: WorkerV2Client, worker_id: str) -> None:
    """Keep one credential alive through transient control-plane outages."""

    while True:
        try:
            await client.connect()
            return
        except asyncio.CancelledError:
            raise
        except ControlPlaneError as exc:
            if exc.code in _FATAL_CONNECT_CODES:
                raise
            if exc.status_code is not None and exc.status_code < 500:
                raise
            logger.warning("Worker connect failed; retrying: %s", exc.code or type(exc).__name__)
        except Exception as exc:
            if not _is_transient_transport_error(exc):
                raise
            logger.warning("Worker connect transport failed; retrying: %s", type(exc).__name__)
        await _retry_pause()


async def _reconnect(client: WorkerV2Client, worker_id: str) -> None:
    # The old session must not be sent with the new handshake after a stale
    # lease. The server will issue the next session epoch authoritatively.
    client.session = None
    logger.warning("Worker %s session is stale; reconnecting", worker_id)
    await _connect_until_ready(client, worker_id)


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


def _build_relay() -> RedisHintClient | None:
    """Create a RedisHintClient if relay env vars are configured, else None."""
    relay_url = os.getenv("WORKER_RELAY_URL", "").strip()
    relay_token = os.getenv("WORKER_RELAY_HINT_TOKEN", "").strip()
    if not relay_url or not relay_token:
        logger.info("WORKER_RELAY_URL not set; Worker will poll control plane only")
        return None
    try:
        return RedisHintClient(base_url=relay_url, token=relay_token)
    except Exception as exc:
        logger.warning("RedisHintClient init failed; falling back to poll-only: %s", exc)
        return None


async def run_worker(worker_id: str) -> None:
    control_plane_url = _required("WORKER_CONTROL_PLANE_URL")
    credential = _required("WORKER_CREDENTIAL")
    instance_id = os.getenv("WORKER_INSTANCE_ID", "").strip() or f"local-{worker_id}"
    image_digest = os.getenv("WORKER_IMAGE_DIGEST", "").strip() or None
    client = WorkerV2Client(
        base_url=control_plane_url,
        worker_id=worker_id,
        credential=credential,
        instance_id=instance_id,
        image_digest=image_digest,
    )
    relay = _build_relay()
    stop = asyncio.Event()
    heartbeat_task: asyncio.Task[Any] | None = None
    try:
        await _connect_until_ready(client, worker_id)
        heartbeat_task = asyncio.create_task(_heartbeat(client, stop))
        while not stop.is_set():
            hints: list[dict[str, Any]] = []
            if relay is not None:
                try:
                    # Hints are advisory only. Control-plane poll/claim is
                    # authoritative, so a Relay outage cannot lose or
                    # duplicate a task.
                    hints = await relay.read(limit=20)
                    if hints:
                        logger.info("Worker %s received %d task hint(s)", worker_id, len(hints))
                except Exception as exc:
                    logger.warning("Redis Relay hint read failed: %s", type(exc).__name__)

            try:
                tasks, next_poll_seconds = await client.poll()
            except ControlPlaneError as exc:
                if exc.code in _FATAL_CONNECT_CODES:
                    raise
                if exc.code in _SESSION_RECONNECT_CODES:
                    await _reconnect(client, worker_id)
                    continue
                logger.warning("Worker poll failed: %s", exc.code or type(exc).__name__)
                await _retry_pause()
                continue
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if not _is_transient_transport_error(exc):
                    raise
                logger.warning("Worker poll transport failed; retrying: %s", type(exc).__name__)
                await _retry_pause()
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
        if relay is not None:
            await relay.close()
        await client.close()


async def _main(worker_id: str) -> None:
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
    await run_worker(worker_id)


if __name__ == "__main__":
    asyncio.run(_main(sys.argv[1] if len(sys.argv) > 1 else os.getenv("WORKER_ID", "")))
