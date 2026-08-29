# PAPER-10 Kimi K2.6 mainland text-gate acceptance

Date: 2026-08-29
Branch: `cloudflare-deploy`

## Evidence source and result

- Provenance: coordinator-provided record from the existing authenticated
  Infinity Agents browser tab. This record is treated as acceptance evidence;
  no browser credential, cookie, storage value, or provider secret is copied
  into this file.
- Corrected Worker version: `79755db3-c12d-4737-b601-aa99f11e3f93`.
- Exact submitted prompt: `请只回复：KIMI_MAINLAND_TEXT_PROBE_OK`.
- Exact visible result: `KIMI_MAINLAND_TEXT_PROBE_OK`.
- Result: real authenticated mainland Kimi K2.6 text-gate `PASS`.
- This supersedes the earlier international-endpoint `401 Invalid
  Authentication` record; it does not claim that the Paper workflow or image
  analysis has passed.
- Kimi K2.6 remains at 100% on the corrected mainland configuration. StepFun
  was not selected or used as a rollback target.

## Boundary

- No credential value, authorization header, cookie, auth storage, paper
  bytes, image bytes, or full provider payload is recorded.
- This probe covered text provider reachability only. Search, supported-source
  materialization, R2 publication, Processor parsing, page/image operations,
  durable tool history, refresh recovery, and negative cases remain pending.
