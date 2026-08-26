"""Entry point for the dedicated, bounded Paper Processor image."""

import os
import time
from pathlib import Path

from .client import from_environment
from .ingest import ExtractionLimits, process_one, recover_processor_workspaces


def main() -> None:
    client = from_environment()
    client.connect()
    work_root = Path(os.environ.get("PAPER_PROCESSOR_WORK_ROOT", "/tmp/paper-processor-work"))
    recover_processor_workspaces(work_root)
    while True:
        try:
            processed = process_one(client, work_root, limits=ExtractionLimits())
        except Exception:
            # Error details are reported through the fenced Edge failure path;
            # the long-lived process reconnects on the next pass.
            try:
                client.connect()
            except Exception:
                pass
            processed = False
        if not processed:
            time.sleep(5)


if __name__ == "__main__":
    main()
