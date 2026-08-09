"""Local protocol spy for the T4/T6 acceptance probes.

Run one instance per protocol, for example:

    python scripts/provider_spy.py --protocol analysis --port 18101
    python scripts/provider_spy.py --protocol coding --port 18102

The spy returns ``/models`` as 404 on purpose.  It records only redacted
request metadata when ``PROVIDER_SPY_LOG`` is set; prompt text and credentials
are never written to the log.
"""

from __future__ import annotations

import argparse
import json
import os
import time
from datetime import datetime, timezone
from typing import Any, AsyncIterator

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse


def _record(protocol: str, request: Request, body: dict[str, Any]) -> None:
    path = os.getenv("PROVIDER_SPY_LOG", "").strip()
    if not path:
        return
    entry = {
        "time": datetime.now(timezone.utc).isoformat(),
        "protocol": protocol,
        "method": request.method,
        "path": request.url.path,
        "model": body.get("model"),
        "stream": bool(body.get("stream")),
        "has_tools": bool(body.get("tools")),
        "has_response_format": bool(body.get("response_format")),
        "content_bytes": len(json.dumps(body, ensure_ascii=False).encode("utf-8")),
        "auth_header_present": bool(request.headers.get("authorization") or request.headers.get("x-api-key")),
    }
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False, sort_keys=True) + "\n")


def _analysis_response(body: dict[str, Any]) -> dict[str, Any]:
    if body.get("tools"):
        return {
            "id": "spy-analysis-tool",
            "object": "chat.completion",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": None, "tool_calls": [{"id": "call_probe", "type": "function", "function": {"name": "probe_tool", "arguments": "{}"}}]}, "finish_reason": "tool_calls"}],
        }
    if body.get("response_format"):
        content = '{"ready":true}'
    else:
        content = "READY"
    return {
        "id": "spy-analysis-json",
        "object": "chat.completion",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
    }


async def _analysis_stream(task_spec: bool = False) -> AsyncIterator[bytes]:
    streamed_content = "READY"
    if task_spec:
        streamed_content = json.dumps({
            "schema_version": "1.0",
            "domain": "bioinformatics",
            "analysis_type": "biopython",
            "research_question": "controlled provider-spy research question",
            "spec_json": {
                "deliverables": [{"path": "results/summary.csv", "required": True, "min_bytes": 1}],
                "clarifications": {"control_groups": "confirmed", "thresholds": "confirmed", "reference_genome": "not applicable"},
            },
        }, separators=(",", ":"))
    for payload in (
        {"id": "spy-analysis-stream", "object": "chat.completion.chunk", "created": int(time.time()), "model": "arbitrary-analysis-model", "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]},
        {"id": "spy-analysis-stream", "object": "chat.completion.chunk", "created": int(time.time()), "model": "arbitrary-analysis-model", "choices": [{"index": 0, "delta": {"content": streamed_content}, "finish_reason": None}]},
        {"id": "spy-analysis-stream", "object": "chat.completion.chunk", "created": int(time.time()), "model": "arbitrary-analysis-model", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
    ):
        yield f"data: {json.dumps(payload)}\n\n".encode("utf-8")
    yield b"data: [DONE]\n\n"


def _coding_response(body: dict[str, Any]) -> dict[str, Any]:
    if body.get("tools"):
        content = [{"type": "tool_use", "id": "tool_probe", "name": "probe_tool", "input": {}}]
        stop_reason = "tool_use"
    else:
        content = [{"type": "text", "text": "READY"}]
        stop_reason = "end_turn"
    return {"id": "spy-coding-message", "type": "message", "role": "assistant", "model": body.get("model"), "content": content, "stop_reason": stop_reason, "usage": {"input_tokens": 1, "output_tokens": 1}}


async def _coding_stream() -> AsyncIterator[bytes]:
    events = (
        ("message_start", {"type": "message_start", "message": {"id": "spy-coding-stream", "type": "message", "role": "assistant", "content": [], "usage": {"input_tokens": 1}}}),
        ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
        ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "READY"}}),
        ("content_block_stop", {"type": "content_block_stop", "index": 0}),
        ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 1}}),
        ("message_stop", {"type": "message_stop"}),
    )
    for event, payload in events:
        yield f"event: {event}\ndata: {json.dumps(payload)}\n\n".encode("utf-8")


def create_app(protocol: str) -> FastAPI:
    app = FastAPI(title=f"{protocol}-spy")

    @app.get("/{path:path}/models")
    async def models(path: str):
        return JSONResponse({"detail": "model discovery intentionally unsupported"}, status_code=404)

    @app.post("/{path:path}/chat/completions")
    async def analysis_chat(request: Request):
        if protocol != "analysis":
            return JSONResponse({"error": "wrong protocol"}, status_code=404)
        body = await request.json()
        _record(protocol, request, body)
        if body.get("stream"):
            return StreamingResponse(_analysis_stream(os.getenv("PROVIDER_SPY_TASK_SPEC", "0") in {"1", "true", "yes"}), media_type="text/event-stream")
        return _analysis_response(body)

    @app.post("/{path:path}/messages/count_tokens")
    async def count_tokens(request: Request):
        if protocol != "coding":
            return JSONResponse({"error": "wrong protocol"}, status_code=404)
        body = await request.json()
        _record(protocol, request, body)
        return {"input_tokens": 1}

    @app.post("/{path:path}/messages")
    async def messages(request: Request):
        if protocol != "coding":
            return JSONResponse({"error": "wrong protocol"}, status_code=404)
        body = await request.json()
        _record(protocol, request, body)
        if body.get("stream"):
            return StreamingResponse(_coding_stream(), media_type="text/event-stream")
        return _coding_response(body)

    @app.get("/health")
    async def health():
        return {"ok": True, "protocol": protocol}

    return app


app = create_app(os.getenv("PROVIDER_SPY_PROTOCOL", "analysis"))


if __name__ == "__main__":
    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument("--protocol", choices=("analysis", "coding"), default="analysis")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18101)
    args = parser.parse_args()
    uvicorn.run(create_app(args.protocol), host=args.host, port=args.port, log_level="warning")
