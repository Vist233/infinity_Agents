# PAPER-08 execution card

- Branch: `cloudflare-deploy`
- Card: PAPER-08 — Edge paper tools and resource-aware Agent behavior
- Baseline commit: `61adfab9d18e457b076ce8918afc9124124c3273`
- Scope: Edge tool schemas and dispatch, resource-aware materialization/read modes, image-analysis request provenance, ownership checks, bounded selectors/results/regex, and prompt/tool/event regression tests.
- Out of scope: actual image delivery and provider egress (PAPER-09), deployment or live infrastructure verification (PAPER-10), and C7 Worker-v2/Redis redesign.

## Acceptance

- [x] `search_paper` retains canonical search behavior and exposes a stable paper reference for the new flow.
- [x] `materialize_paper` creates or reuses a session/user-owned durable resource and returns explicit processing state.
- [x] `read_paper` uses resource IDs for full text and supports bounded `text`, `search`, `outline`, and `images` modes.
- [x] Abstract reads remain explicitly labeled `abstract`; pending/failed resources return `processing` and never silently downgrade to an abstract.
- [x] Page selection, search query/regex, manifest parsing, image metadata, and tool result size are bounded; citations contain only resource ID, page, and excerpt.
- [x] `analyze_paper_image` accepts only a ready owned resource and a manifest image, returning bounded provenance without paths, object keys, or bytes.
- [x] Repeated materialization is idempotent; cross-user/resource, missing page/image, failed-resource, unsafe-regex, and invalid-mode cases are covered.
- [x] The model prompt and tool loop pass the authenticated user ID into resource-aware tools; durable chat event persistence continues to record tool calls/results.
- [x] No model call receives an R2 key, processor credential, or parent storage credential.
- [x] No deployment, remote migration, remote R2 write, Processor registration, Redis ACL change, secret rotation, or Cloudflare configuration change was performed.
