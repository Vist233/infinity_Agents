"""One-work-item Discovery Processor loop.

The runtime is deliberately stateless: all durable progress is committed by
the Edge through fenced, idempotent control calls.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

from .client import DiscoveryGrant, DiscoveryProcessorClient, from_environment
from .dataset_inspector import DatasetInspectionError, inspect_path
from .evaluator import EvaluatorError, evaluate_feasibility
from .llm import MoonshotJsonClient
from .paper_profile import PaperProfileError, compile_paper_profile, render_overview


LOGGER = logging.getLogger("infinity.discovery_processor")
MAX_PAPER_BYTES = 64 * 1024 * 1024
MAX_DATASET_BYTES = 25 * 1024 * 1024


def _parse_text_pages(body: bytes) -> list[str]:
    pages: list[str] = []
    for line in body.decode("utf-8").splitlines()[:500]:
        if not line.strip():
            continue
        value = json.loads(line)
        if isinstance(value, dict) and isinstance(value.get("text"), str):
            pages.append(value["text"][:100_000])
    if not pages:
        raise PaperProfileError("PAPER_TEXT_EMPTY")
    return pages


class LeaseHeartbeat:
    def __init__(self, client: DiscoveryProcessorClient, grant: DiscoveryGrant, interval_seconds: float = 90.0) -> None:
        self.client = client
        self.grant = grant
        self.interval_seconds = interval_seconds
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self._run, name="discovery-lease-heartbeat", daemon=True)

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        self.thread.join(timeout=2)

    def _run(self) -> None:
        while not self.stop_event.wait(self.interval_seconds):
            try:
                self.client.renew(self.grant)
            except Exception:
                LOGGER.warning("discovery_processor event=lease_renew_failed work_kind=%s", self.grant.kind)


def _fail(client: DiscoveryProcessorClient, grant: DiscoveryGrant, code: str, spam_status: str | None = None) -> None:
    try:
        client.fail(grant, code, spam_status)
    except Exception:
        LOGGER.warning("discovery_processor event=fail_report_failed work_kind=%s", grant.kind)


def _model_from_environment() -> Any | None:
    enabled = os.environ.get("DISCOVERY_USE_MODEL", "false").strip().lower() == "true"
    if not enabled:
        return None
    return MoonshotJsonClient()


def process_one(client: DiscoveryProcessorClient, *, work_root: Path, model: Any | None = None) -> bool:
    grant = client.poll()
    if grant is None:
        return False
    heartbeat = LeaseHeartbeat(client, grant)
    heartbeat.start()
    try:
        if grant.kind == "paper":
            body = client.input_source(grant, MAX_PAPER_BYTES)
            pages = _parse_text_pages(body)
            profile = compile_paper_profile(pages, grant.resource_id or "", model=model, input_sha256=hashlib.sha256(body).hexdigest())
            client.save_paper_profile(grant, profile, render_overview(profile))
            LOGGER.info("discovery_processor event=paper_profiled")
            return True
        if grant.kind == "collection":
            metadata = client.input(grant)
            source_filename = metadata.get("source_filename") if isinstance(metadata, dict) else None
            if not isinstance(source_filename, str) or not source_filename.strip():
                raise DatasetInspectionError("DATASET_FILENAME_MISSING", "Dataset source filename is missing")
            body = client.input_source(grant, MAX_DATASET_BYTES)
            work_root.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(prefix="discovery-inspect-", dir=work_root) as temporary:
                # The inspector intentionally uses the filename suffix to
                # select its bounded parser.  Keep only a basename from the
                # untrusted Edge metadata so a path can never escape the
                # processor work directory.
                safe_name = Path(source_filename.replace("\\", "/")).name
                if not safe_name or safe_name in {".", ".."}:
                    raise DatasetInspectionError("DATASET_FILENAME_INVALID", "Dataset source filename is invalid")
                source = Path(temporary) / safe_name
                source.write_bytes(body)
                profile = inspect_path(source, grant.work_id)
            client.save_dataset_profile(grant, profile)
            LOGGER.info("discovery_processor event=dataset_profiled")
            return True
        source = client.input_source(grant, 2 * MAX_PAPER_BYTES)
        envelope = json.loads(source.decode("utf-8"))
        if not isinstance(envelope, dict) or not isinstance(envelope.get("paper_profile"), dict) or not isinstance(envelope.get("dataset_profile"), dict):
            raise EvaluatorError("MATCH_INPUT_INVALID")
        evaluation = evaluate_feasibility(envelope["paper_profile"], envelope["dataset_profile"], environment={"supports_tabular": True}, model=model)
        client.save_evaluation(grant, evaluation)
        LOGGER.info("discovery_processor event=match_evaluated")
        return True
    except PaperProfileError as error:
        code = str(error).split(" ", 1)[0].upper()[:64]
        _fail(client, grant, code, "spam" if code == "DOCUMENT_GATE_SPAM" else "non_paper" if code == "DOCUMENT_GATE_NON_PAPER" else "invalid" if code.startswith("DOCUMENT_GATE_INVALID") else "review")
        raise
    except DatasetInspectionError as error:
        _fail(client, grant, error.code)
        raise
    except (EvaluatorError, ValueError, json.JSONDecodeError):
        _fail(client, grant, "DISCOVERY_EVALUATION_FAILED")
        raise
    except Exception:
        _fail(client, grant, "DISCOVERY_PROCESSOR_RUNTIME_ERROR")
        raise
    finally:
        heartbeat.stop()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    client = from_environment()
    client.connect()
    work_root = Path(os.environ.get("DISCOVERY_PROCESSOR_WORK_ROOT", "/tmp/discovery-processor-work"))
    model = _model_from_environment()
    while True:
        try:
            processed = process_one(client, work_root=work_root, model=model)
        except Exception:
            try:
                client.connect()
            except Exception:
                pass
            processed = False
        if not processed:
            time.sleep(5)


if __name__ == "__main__":
    main()
