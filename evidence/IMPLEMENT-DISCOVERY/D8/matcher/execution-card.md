# D8 — Matching Engine

Date: 2026-09-11 (Asia/Shanghai)
Status: PASS (versioned candidate matching; real production opportunity pending)

The matcher uses normalized capability keys rather than display-tag overlap.
It records supported analysis modules, total modules, coverage ratio, missing
required capabilities, and a candidate reason in `research_matches`. Paper and
dataset profile versions are part of the match identity, so a new profile
version creates a new fact instead of overwriting an earlier match.

The matcher is candidate-only. It cannot create a Task and does not bypass the
Feasibility Evaluator or its threshold.
