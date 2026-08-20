from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any

import httpx
import pytest

from backend.redis_relay import RelaySettings, create_app


class FakeRedis:
    def __init__(self) -> None:
        self.seen: set[str] = set()
        self.streams: dict[str, list[tuple[str, dict[str, str]]]] = {}
        self.sequence = 0
        self.unavailable = False

    async def ping(self) -> bool:
        if self.unavailable:
            raise ConnectionError("redis down")
        return True

    async def eval(self, _script: str, numkeys: int, *args: str) -> str | None:
        if self.unavailable:
            raise ConnectionError("redis down")
        assert numkeys == 2
        seen_key, stream_key = args[:2]
        event_id, idempotency_key, task_id, event_type, pool_id, created_at = args[4:]
        if seen_key in self.seen:
            return None
        self.seen.add(seen_key)
        self.sequence += 1
        cursor = f"{self.sequence}-0"
        self.streams.setdefault(stream_key, []).append(
            (
                cursor,
                {
                    "event_id": event_id,
                    "idempotency_key": idempotency_key,
                    "task_id": task_id,
                    "event_type": event_type,
                    "pool_id": pool_id,
                    "created_at": created_at,
                },
            )
        )
        return cursor

    async def xread(self, streams: dict[str, str], count: int) -> list[Any]:
        if self.unavailable:
            raise ConnectionError("redis down")
        output: list[Any] = []
        for stream_key, cursor in streams.items():
            last = int(cursor.split("-", 1)[0])
            entries = [entry for entry in self.streams.get(stream_key, []) if int(entry[0].split("-", 1)[0]) > last]
            if entries:
                output.append((stream_key, entries[:count]))
        return output

    async def aclose(self) -> None:
        return None


def signed_headers(settings: RelaySettings, body: bytes, timestamp: int | None = None) -> dict[str, str]:
    ts = str(timestamp or int(time.time()))
    canonical = b"\n".join((ts.encode(), b"POST", b"/v1/events", body))
    signature = hmac.new(settings.publish_secret.encode(), canonical, hashlib.sha256).hexdigest()
    return {
        "content-type": "application/json",
        "x-relay-timestamp": ts,
        "x-relay-signature": f"sha256={signature}",
    }


def event_body(**overrides: Any) -> bytes:
    event = {
        "event_id": "event-1",
        "idempotency_key": "task-queued:task-1",
        "task_id": "task-1",
        "event_type": "task_queued",
        "pool_id": "public-default",
        "created_at": 1_700_000_000,
    }
    event.update(overrides)
    return json.dumps(event, separators=(",", ":")).encode()


@pytest.fixture
def relay_parts() -> tuple[RelaySettings, FakeRedis]:
    settings = RelaySettings(
        redis_url="redis://unused",
        publish_secret="publish-test-secret",
        hint_token="hint-test-token",
    )
    return settings, FakeRedis()


@pytest.mark.asyncio
async def test_signed_publish_is_fixed_shape_and_idempotent(relay_parts: tuple[RelaySettings, FakeRedis]) -> None:
    settings, redis = relay_parts
    app = create_app(settings=settings, redis_client=redis)
    body = event_body()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://relay.test") as client:
        first = await client.post("/v1/events", content=body, headers=signed_headers(settings, body))
        second = await client.post("/v1/events", content=body, headers=signed_headers(settings, body))
    assert first.status_code == 200
    assert first.json() == {"accepted": True, "duplicate": False, "cursor": "published"}
    assert second.status_code == 200
    assert second.json() == {"accepted": True, "duplicate": True, "cursor": None}
    assert len(redis.streams[settings.stream_key]) == 1
    fields = redis.streams[settings.stream_key][0][1]
    assert set(fields) == {"event_id", "idempotency_key", "task_id", "event_type", "pool_id", "created_at"}


@pytest.mark.asyncio
async def test_invalid_signature_extra_fields_and_expired_request_are_rejected(relay_parts: tuple[RelaySettings, FakeRedis]) -> None:
    settings, redis = relay_parts
    app = create_app(settings=settings, redis_client=redis)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://relay.test") as client:
        bad = await client.post("/v1/events", content=event_body(), headers={"content-type": "application/json"})
        extra_body = event_body(redis_key="raw:redis:key")
        extra = await client.post("/v1/events", content=extra_body, headers=signed_headers(settings, extra_body))
        expired_body = event_body(event_id="event-expired")
        expired = await client.post(
            "/v1/events",
            content=expired_body,
            headers=signed_headers(settings, expired_body, timestamp=int(time.time()) - 301),
        )
    assert bad.status_code == 401
    assert extra.status_code == 422
    assert expired.status_code == 401
    assert redis.streams == {}


@pytest.mark.asyncio
async def test_hints_are_low_privilege_fixed_records_and_fail_closed(relay_parts: tuple[RelaySettings, FakeRedis]) -> None:
    settings, redis = relay_parts
    app = create_app(settings=settings, redis_client=redis)
    body = event_body()
    publish_headers = signed_headers(settings, body)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://relay.test") as client:
        await client.post("/v1/events", content=body, headers=publish_headers)
        unauthorized = await client.get("/v1/hints")
        response = await client.get("/v1/hints?limit=1", headers={"authorization": "Bearer hint-test-token"})
        redis.unavailable = True
        unavailable = await client.get("/v1/hints", headers={"authorization": "Bearer hint-test-token"})
    assert unauthorized.status_code == 401
    assert response.status_code == 200
    assert response.json()["items"] == [{
        "cursor": "1-0",
        "event_id": "event-1",
        "idempotency_key": "task-queued:task-1",
        "task_id": "task-1",
        "event_type": "task_queued",
        "pool_id": "public-default",
        "created_at": "1700000000",
        "status": "queued",
    }]
    assert unavailable.status_code == 503
