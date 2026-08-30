"""Entry point for the dedicated, bounded Paper Processor image."""

import logging
import os
import time
from pathlib import Path

from .client import from_environment
from .ingest import ExtractionLimits, ProcessorError, ProcessorRuntimeLimits, process_one, recover_processor_workspaces


LOGGER = logging.getLogger("infinity.paper_processor")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    client = from_environment()
    try:
        client.connect()
    except Exception:
        LOGGER.error("paper_processor event=connect_failed error_code=PAPER_PROCESSOR_CONNECT_FAILED")
        raise SystemExit(1)
    work_root = Path(os.environ.get("PAPER_PROCESSOR_WORK_ROOT", "/tmp/paper-processor-work"))
    recover_processor_workspaces(work_root)
    runtime_limits = ProcessorRuntimeLimits.from_environment()
    extraction_limits = ExtractionLimits(max_resident_memory_bytes=runtime_limits.max_resident_memory_bytes)
    LOGGER.info(
        "paper_processor event=started attempt_timeout_seconds=%s heartbeat_interval_seconds=%s memory_budget_bytes=%s",
        runtime_limits.attempt_timeout_seconds,
        runtime_limits.heartbeat_interval_seconds,
        runtime_limits.max_resident_memory_bytes,
    )
    while True:
        try:
            processed = process_one(client, work_root, limits=extraction_limits, runtime_limits=runtime_limits)
        except ProcessorError as error:
            LOGGER.warning("paper_processor event=attempt_failed error_code=%s", error.code)
            try:
                client.connect()
            except Exception:
                pass
            processed = False
        except Exception:
            # Details are intentionally omitted: the Edge receives only the
            # bounded failure code and the next poll remains the recovery path.
            LOGGER.warning("paper_processor event=attempt_cancelled error_code=PAPER_PROCESSOR_RUNTIME_ERROR")
            try:
                client.connect()
            except Exception:
                pass
            processed = False
        if not processed:
            LOGGER.info("paper_processor event=poll_empty")
            time.sleep(5)


if __name__ == "__main__":
    main()
