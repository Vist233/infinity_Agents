"""Run the single-model Analysis Agent against the local protocol spy."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.code_agent.analysis_agent import _call_llm_for_analysis


async def main() -> None:
    events = []
    async for event in _call_llm_for_analysis("case2 Biopython analysis with the controlled dataset"):
        events.append(event)
    print(json.dumps({
        "event_types": [event.get("type") for event in events],
        "has_task_spec": any(event.get("type") == "task_spec_draft" and not event.get("validation_errors") for event in events),
        "chunk_count": sum(event.get("type") == "chunk" for event in events),
    }, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
