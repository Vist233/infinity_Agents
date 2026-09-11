"""Paper Discovery processor components.

The package is deliberately independent from the existing Paper Processor and
Worker v2 runtimes. It contains bounded, JSON-only contracts and deterministic
inspection/evaluation helpers that can be exercised without network access.
"""

from .contracts import (
    CAPABILITY_KEY_PATTERN,
    DATASET_PROFILE_VERSION,
    FEASIBILITY_EVALUATOR_VERSION,
    PAPER_PROFILE_VERSION,
    PUBLICATION_EVALUATOR_VERSION,
    coarse_match,
    normalize_dataset_profile,
    normalize_feasibility_evaluation,
    normalize_paper_profile,
    passes_automatic_threshold,
)

__all__ = [
    "CAPABILITY_KEY_PATTERN",
    "DATASET_PROFILE_VERSION",
    "FEASIBILITY_EVALUATOR_VERSION",
    "PAPER_PROFILE_VERSION",
    "PUBLICATION_EVALUATOR_VERSION",
    "coarse_match",
    "normalize_dataset_profile",
    "normalize_feasibility_evaluation",
    "normalize_paper_profile",
    "passes_automatic_threshold",
]
