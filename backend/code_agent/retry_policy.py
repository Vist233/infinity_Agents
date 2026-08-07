"""Infinity Agent — Retry backoff policy with jitter."""

from __future__ import annotations

import random
from datetime import datetime, timedelta, timezone
from typing import Optional

# Failures that should NOT be retried automatically (design doc §35.2).
NON_RETRYABLE_FAILURE_CODES = {
    "verification_failed",
    "invalid_spec",
    "dataset_invalid",
}


def is_retryable(failure_code: Optional[str]) -> bool:
    """Classify a failure code as retryable or not (design doc §35)."""
    if not failure_code:
        return True
    return failure_code not in NON_RETRYABLE_FAILURE_CODES


def calculate_retry_delay(attempt_count: int, base_delay_seconds: float = 5.0, max_delay_seconds: float = 300.0) -> timedelta:
    """Calculate retry delay with exponential backoff and full jitter.

    Delay = random(0, min(base * 2^attempt, max))
    """
    delay = min(base_delay_seconds * (2 ** attempt_count), max_delay_seconds)
    jittered = random.uniform(0, delay)
    return timedelta(seconds=jittered)


def next_attempt_at(attempt_count: int, now: Optional[datetime] = None) -> datetime:
    """Compute the next allowed attempt time."""
    if now is None:
        now = datetime.now(timezone.utc)
    delay = calculate_retry_delay(attempt_count)
    return now + delay
