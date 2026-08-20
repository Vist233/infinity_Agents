# EXEC-C5-CASE2-RETRY1: validate the patched real Case 2 artifact path

## Control

- run ID: `IMPLEMENT-20260820-D1`
- stage: C5
- baseline commit: `678fcec9dca53130c0560eb76a21cc5b3c563684`
- scope: one browser-created real Case 2 Task and read-only runtime verification
- external system action: the user created and uploaded the frozen Case 2 inputs through Task Center; the Worker then executed the task.

## One observable outcome

The patched D1/R2 multipart path must take a real Case 2 Task from queued to `succeeded`, publish exactly one Artifact, and allow a downloaded ZIP to match the server SHA-256.

## Non-goals

- Do not manually insert, update, requeue, or mark any D1 Task/Attempt as successful.
- Do not repair the zhangbot Redis ACL in this card.
- Do not run Case 3 before Case 2 has complete evidence.

## Inputs

- Method: Biopython Cookbook HTML, 206,528 bytes, SHA-256 `be7b027a9a75806abb2fc1c9c914b8eb273dfcdac74851d08f401f8ab6a09d03`.
- Dataset: `infinity-case2-dataset.zip`, 11,423 bytes, SHA-256 `fe4b245d9695a227a3151c2ef8a470f95742af495b7f9428c894fe91204f381b`.
- Worker: local `infinity-agent-worker-b-v2`, D1 Worker ID `public-worker-75f39f88-f921-4929-9c8d-a9f0c1b57145`.

## Acceptance

1. A Task Center-created Task is claimed by the v2 Worker without manual D1 writes.
2. Claude Code receives the fixed Goal-Driven Prompt and produces the Case 2 deliverables.
3. D1 has exactly one succeeded Attempt and one published Artifact.
4. The R2-downloaded ZIP has the same SHA-256 as D1, passes `unzip -t`, and contains 94-sequence statistics and a parseable 94-tip Newick tree.
5. The completed attempt directory is empty and the Worker session remains online.
