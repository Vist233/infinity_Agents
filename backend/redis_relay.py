"""Small HTTPS boundary for the central Redis hint stream.

Redis is an implementation detail of the Infinity Agents runtime.  Cloudflare
D1 remains the source of truth for tasks, and Workers use the v2 HTTPS control
plane for claims, inputs, leases, and artifacts.  This service only carries a
reconstructible wake-up hint so a Worker can sleep between polls without
receiving a Redis credential or an arbitrary Redis command.

The relay intentionally exposes two fixed operations:

* ``POST /v1/events`` accepts a signed, fixed-shape D1 outbox event.
* ``GET /v1/hints`` returns fixed-shape stream entries to an enrolled Worker.

There is no user-provided Redis key, command, stream name, payload, or D1
connection string in either operation.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import re
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, Literal, Mapping, Protocol, Sequence

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

logger = logging.getLogger(__name__)

_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,160}$")
_CURSOR_RE = re.compile(r"^(?:0-0|[0-9]{1,20}-[0-9]{1,20})$")
_MAX_HINTS = 100
_EVENT_TTL_SECONDS = 7 * 24 * 60 * 60
_STREAM_MAXLEN = 100_000
_DEFAULT_SKEW_SECONDS = 300
_EVENT_TYPES = {
    "task_queued",
    "task_claimed",
    "task_running",
    "task_succeeded",
    "task_failed",
    "task_cancelled",
}
_STATUS_BY_EVENT = {
    "task_queued": "queued",
    "task_claimed": "claimed",
    "task_running": "running",
    "task_succeeded": "succeeded",
    "task_failed": "failed",
    "task_cancelled": "cancelled",
}

# The script is constant.  Request fields are values only; callers cannot
# choose a Redis command or key.  SET + XADD are atomic, so a retry cannot
# publish a second stream entry for the same D1 idempotency key.
_PUBLISH_SCRIPT = """
if redis.call('SET', KEYS[1], '1', 'EX', ARGV[1], 'NX') then
  return redis.call(
    'XADD', KEYS[2], 'MAXLEN', '~', ARGV[2], '*',
    'event_id', ARGV[3],
    'idempotency_key', ARGV[4],
    'task_id', ARGV[5],
    'event_type', ARGV[6],
    'pool_id', ARGV[7],
    'created_at', ARGV[8]
  )
end
return false
"""


class RedisLike(Protocol):
    async def ping(self) -> Any: ...

    async def eval(self, script: str, numkeys: int, *keys_and_args: str) -> Any: ...

    async def xread(self, streams: Mapping[str, str], count: int) -> Any: ...

    async def aclose(self) -> Any: ...


@dataclass(frozen=True)
class RelaySettings:
    redis_url: str
    publish_secret: str
    hint_token: str
    namespace: str = "infinity-public"
    timestamp_skew_seconds: int = _DEFAULT_SKEW_SECONDS

    @property
    def stream_key(self) -> str:
        return f"{self.namespace}:stream:task-hints"

    @property
    def seen_key_prefix(self) -> str:
        return f"{self.namespace}:relay:seen:"

    @classmethod
    def from_env(cls) -> "RelaySettings":
        namespace = os.getenv("REDIS_RELAY_NAMESPACE", "infinity-public").strip()
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", namespace):
            raise RuntimeError("REDIS_RELAY_NAMESPACE contains unsupported characters")
        return cls(
            redis_url=os.getenv("REDIS_URL", "").strip(),
            publish_secret=os.getenv("REDIS_RELAY_PUBLISH_SECRET", ""),
            hint_token=os.getenv("REDIS_RELAY_HINT_TOKEN", ""),
            namespace=namespace,
            timestamp_skew_seconds=max(30, min(int(os.getenv("REDIS_RELAY_TIMESTAMP_SKEW_SECONDS", "300")), 900)),
        )


class RelayEvent(BaseModel):
    """The only event shape accepted from the D1 outbox flusher."""

    model_config = ConfigDict(extra="forbid")

    event_id: str = Field(min_length=1, max_length=160)
    idempotency_key: str = Field(min_length=1, max_length=160)
    task_id: str = Field(min_length=1, max_length=160)
    event_type: Literal[
        "task_queued",
        "task_claimed",
        "task_running",
        "task_succeeded",
        "task_failed",
        "task_cancelled",
    ]
    pool_id: Literal["public-default"]
    created_at: int = Field(gt=0)

    @classmethod
    def validate_ids(cls, value: str, field_name: str) -> str:
        if not _ID_RE.fullmatch(value):
            raise ValueError(f"{field_name} contains unsupported characters")
        return value

    def model_post_init(self, __context: Any) -> None:
        for field_name in ("event_id", "idempotency_key", "task_id"):
            self.validate_ids(getattr(self, field_name), field_name)


class RelayService:
    def __init__(self, settings: RelaySettings, redis_client: RedisLike | None = None) -> None:
        self.settings = settings
        self.redis = redis_client
        self._owns_client = redis_client is None

    async def connect(self) -> None:
        if self.redis is not None:
            return
        if not self.settings.redis_url:
            raise RuntimeError("REDIS_URL is required")
        try:
            import redis.asyncio as aioredis
        except ImportError as exc:  # pragma: no cover - requirements include redis
            raise RuntimeError("redis package is required") from exc
        self.redis = aioredis.from_url(
            self.settings.redis_url,
            decode_responses=True,
            socket_connect_timeout=5,
            socket_timeout=10,
        )

    async def close(self) -> None:
        if self.redis is not None and self._owns_client:
            try:
                await self.redis.aclose()
            finally:
                self.redis = None

    async def ping(self) -> None:
        await self._require_redis().ping()

    def _require_redis(self) -> RedisLike:
        if self.redis is None:
            raise RuntimeError("Redis relay is not connected")
        return self.redis

    async def publish(self, event: RelayEvent) -> bool:
        redis = self._require_redis()
        result = await redis.eval(
            _PUBLISH_SCRIPT,
            2,
            f"{self.settings.seen_key_prefix}{event.idempotency_key}",
            self.settings.stream_key,
            str(_EVENT_TTL_SECONDS),
            str(_STREAM_MAXLEN),
            event.event_id,
            event.idempotency_key,
            event.task_id,
            event.event_type,
            event.pool_id,
            str(event.created_at),
        )
        return bool(result)

    async def hints(self, cursor: str, limit: int) -> list[dict[str, str]]:
        rows = await self._require_redis().xread({self.settings.stream_key: cursor}, count=limit)
        result: list[dict[str, str]] = []
        for stream_name, entries in rows or []:
            if _as_text(stream_name) != self.settings.stream_key:
                continue
            for stream_id, fields in entries or []:
                data = {str(_as_text(k)): str(_as_text(v)) for k, v in _mapping_items(fields)}
                event_type = data.get("event_type", "")
                if event_type not in _EVENT_TYPES:
                    continue
                if data.get("pool_id") != "public-default":
                    continue
                if not all(data.get(key) for key in ("event_id", "idempotency_key", "task_id", "created_at")):
                    continue
                result.append({
                    "cursor": _as_text(stream_id),
                    "event_id": data["event_id"],
                    "idempotency_key": data["idempotency_key"],
                    "task_id": data["task_id"],
                    "event_type": event_type,
                    "pool_id": "public-default",
                    "created_at": data["created_at"],
                    "status": _STATUS_BY_EVENT[event_type],
                })
        return result


def _as_text(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return str(value)


def _mapping_items(value: Any) -> Sequence[tuple[Any, Any]]:
    if isinstance(value, Mapping):
        return list(value.items())
    return []


def _request_signature(secret: str, timestamp: str, method: str, path: str, body: bytes) -> str:
    message = b"\n".join((timestamp.encode(), method.upper().encode(), path.encode(), body))
    return hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()


def _unauthorized(message: str = "Relay authentication failed") -> JSONResponse:
    return JSONResponse({"error": {"code": "RELAY_UNAUTHORIZED", "message": message}}, status_code=401)


async def _authenticate_publish(request: Request, settings: RelaySettings, body: bytes) -> JSONResponse | None:
    if not settings.publish_secret:
        return JSONResponse({"error": {"code": "RELAY_NOT_CONFIGURED"}}, status_code=503)
    timestamp = request.headers.get("x-relay-timestamp", "")
    signature = request.headers.get("x-relay-signature", "")
    if not timestamp.isdigit() or not signature.startswith("sha256="):
        return _unauthorized()
    try:
        age = abs(int(time.time()) - int(timestamp))
    except ValueError:
        return _unauthorized()
    if age > settings.timestamp_skew_seconds:
        return _unauthorized("Relay signature is expired")
    expected = _request_signature(settings.publish_secret, timestamp, request.method, request.url.path, body)
    if not hmac.compare_digest(signature.removeprefix("sha256="), expected):
        return _unauthorized()
    return None


def _authenticate_hint(request: Request, settings: RelaySettings) -> JSONResponse | None:
    if not settings.hint_token:
        return JSONResponse({"error": {"code": "RELAY_NOT_CONFIGURED"}}, status_code=503)
    presented = request.headers.get("authorization", "")
    expected = f"Bearer {settings.hint_token}"
    if not hmac.compare_digest(presented, expected):
        return _unauthorized()
    return None


def _error(code: str, message: str, status: int) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status)


def create_app(*, settings: RelaySettings | None = None, redis_client: RedisLike | None = None) -> FastAPI:
    relay_settings = settings or RelaySettings.from_env()
    service = RelayService(relay_settings, redis_client)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        try:
            await service.connect()
            yield
        finally:
            await service.close()

    app = FastAPI(title="Infinity Agents Redis Relay", docs_url=None, redoc_url=None, lifespan=lifespan)
    app.state.relay = service

    @app.get("/health")
    async def health() -> JSONResponse:
        try:
            await service.ping()
        except Exception:
            return _error("REDIS_UNAVAILABLE", "Redis relay is unavailable", 503)
        return JSONResponse({"status": "ok", "service": "infinity-redis-relay"})

    @app.post("/v1/events")
    async def publish_event(request: Request) -> JSONResponse:
        body = await request.body()
        auth_error = await _authenticate_publish(request, relay_settings, body)
        if auth_error:
            return auth_error
        try:
            event = RelayEvent.model_validate_json(body)
        except ValidationError:
            return _error("INVALID_RELAY_EVENT", "Only the fixed D1 event shape is accepted", 422)
        except ValueError:
            return _error("INVALID_RELAY_EVENT", "Event body must be JSON", 400)
        try:
            published = await service.publish(event)
        except Exception:
            logger.warning("Redis relay publish failed")
            return _error("REDIS_UNAVAILABLE", "Redis relay is unavailable", 503)
        return JSONResponse({"accepted": True, "duplicate": not published, "cursor": None if not published else "published"})

    @app.get("/v1/hints")
    async def read_hints(request: Request) -> JSONResponse:
        auth_error = _authenticate_hint(request, relay_settings)
        if auth_error:
            return auth_error
        cursor = request.query_params.get("cursor", "0-0")
        raw_limit = request.query_params.get("limit", "20")
        if not _CURSOR_RE.fullmatch(cursor):
            return _error("INVALID_CURSOR", "Cursor must be a Redis stream ID", 400)
        try:
            limit = int(raw_limit)
        except ValueError:
            return _error("INVALID_LIMIT", "Limit must be an integer", 400)
        if limit < 1 or limit > _MAX_HINTS:
            return _error("INVALID_LIMIT", f"Limit must be between 1 and {_MAX_HINTS}", 400)
        try:
            items = await service.hints(cursor, limit)
        except Exception:
            logger.warning("Redis relay hint read failed")
            return _error("REDIS_UNAVAILABLE", "Redis relay is unavailable", 503)
        return JSONResponse({"items": items, "next_cursor": items[-1]["cursor"] if items else cursor})

    return app


app = create_app()


if __name__ == "__main__":  # pragma: no cover - operational entry point
    import uvicorn

    uvicorn.run("backend.redis_relay:app", host="0.0.0.0", port=int(os.getenv("PORT", "8090")))
