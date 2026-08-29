# PAPER-10 real browser acceptance — exact remaining checklist

This checklist is the only remaining release gate. Use the existing
authenticated Infinity Agents tab/session; do not create a new session or
replace the session. Record only opaque IDs, statuses, bounded counts, and
redacted errors. Never record cookies, credentials, R2 keys, source URLs that
are not already safe canonical refs, PDF/full-text/image bytes, or provider
payloads.

1. Search for a supported open-access paper through the visible application.
   Confirm the result's canonical source reference is one of the allowlisted
   sources (for example, an actual returned arXiv reference), not an arbitrary
   URL.
2. Materialize that returned paper. Confirm the durable tool timeline contains
   the real `search_paper` and `materialize_paper` call/result and the Paper
   task surface progresses through `requested`, `downloading`, `extracting`,
   or `uploading`. A successful materialize tool result while processing must
   not be displayed as `ready`.
3. Refresh during processing. Confirm the same owner-scoped correlation,
   resource identity, and bounded status/counts are rehydrated; assistant
   prose must not be used as task state.
4. Wait for the real zhangbot Processor to finish. Confirm the authenticated
   progress model becomes `ready`, D1 resource/attempt state is successful,
   and the R2 source PDF plus validated text/image manifests exist. Do not
   substitute HTTP 200, process liveness, mock data, or model prose.
5. Read a bounded page-text range through `read_paper`; confirm it is sourced
   from the ready resource. Read the image manifest, view one authorized image,
   and perform one authorized image-analysis action. Confirm safe provider
   egress/audit evidence. No object key or parent credential may reach the UI.
6. Refresh after `ready`. Confirm the timeline, progress, counts, and
   ready-only resume/read action persist. Click resume once and verify the
   existing continuation produces a real subsequent read/image tool event; a
   duplicate click must not create a second continuation/run.
7. With a separate authenticated non-owner session, attempt progress, page
   text, image, and continuation access using the first user's opaque resource
   ID. Each must return the contract's uniform denied/not-found boundary with
   no title, text, image bytes, source URL, R2 key, or cross-user event/object
   access.
8. Read back only safe D1/R2/Processor/WAF/provider-egress metadata after the
   flow, and preserve redacted logs. Mark PAPER-10 PASS only if every item
   passes; otherwise record `BLOCKED_BROWSER_ACCEPTANCE` and the exact failed
   item.
