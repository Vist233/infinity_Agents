# PAPER-10 Edge service-to-service access subphase

- Started: 2026-08-28
- Branch: `cloudflare-deploy`
- Baseline commit: `e72ad26b5b18b153f9b780dd678e0282aaf188b3`
- Existing release commit: `3558c1fec9035465407ca121fea94bd77e74d7bd`
- Existing checkpoint: `BLOCKED_PROCESSOR_EDGE_ACCESS`

## Single objective

Resolve the real Cloudflare 403/Error 1010 on the fixed zhangbot Processor
service-to-service control path with a formally constrained, reviewable access
contract. The final rule must permit only the exact Processor methods and paths
from zhangbot's stable egress identity while preserving Worker shared-secret,
Processor-ID, nonce, lease, and source-admission checks.

## Allowed scope

- Read and, after local review/backup, change only the Paper Processor client,
  exact Edge Processor routes/access policy, tests, design/runbook, and PAPER-10
  evidence needed for this subphase.
- Use only the already approved `cloudflare-deploy` branch, fixed Edge
  `https://infinity.zhangyvjing.com`, and the single approved zhangbot host.
- Preserve D1 migrations `0017`–`0021`; do not hand-edit D1 metadata.
- Keep the existing Redis, Redis Relay, and Cloudflared services unchanged.

## Explicit non-goals

- No fake browser User-Agent, browser-signature evasion, arbitrary proxy, new
  host, public listener, wide-path or whole-site Bot/WAF bypass.
- No parent D1/R2/Redis/Cloudflare/provider credential on zhangbot, in tests,
  logs, or evidence.
- No external write occurs until the exact path/method/source-IP rule is
  expressible, local positive/negative tests pass, and the reviewed commit is
  backed up with an exact remote-ref readback.

## Rollback boundary

If the access rule, secret, token, service, release, or Edge deployment is
created and a later gate fails, revoke the new capability/rule first, stop and
disable the one Processor, remove only the new token/release/unit, preserve D1
and R2 metadata, and leave Redis/Relay/Cloudflared untouched. Keep this
subphase blocked until a fresh read-only preflight and the real authenticated
PAPER-10 acceptance pass.

## Read-only investigation result

The checked-in Processor client and Edge handler agree on the following
service-to-service protocol. Values below are names and paths only; no token or
secret value was printed or persisted.

| Operation | Method and path | Authentication after edge admission |
|---|---|---|
| Connect | `POST /api/paper-processor/connect` | Processor ID plus bootstrap token/shared secret |
| Poll | `POST /api/paper-processor/poll` | Short-lived Processor session |
| Read input | `GET /api/paper-processor/attempts/<attempt>/input` or `/input/object` | Session, lease, fencing epoch, resource ownership |
| Renew/stage/finalize/cancel/fail | `POST /api/paper-processor/attempts/<attempt>/{renew,stage,finalize,cancel,fail}` | Session, lease, fencing epoch, attempt state |
| Publish objects | `PUT /api/paper-processor/attempts/<attempt>/objects/{source_pdf,text_pages,text_manifest,image,image_manifest}` | Session, lease, fencing epoch, resource ownership |

The client uses the fixed HTTPS host `infinity.zhangyvjing.com`, sends the
Processor ID and token only on connect, then uses the issued session and lease
headers. There is no browser User-Agent or alternate transport path. A
read-only SSH check of zhangbot returned `39.105.204.121` from three public
egress providers and the Cloudflare trace; the default route is IPv4 and no
stable IPv6 result was available. No Processor unit, release, token file,
listener, or Docker runtime exists on zhangbot. Redis, Redis Relay, and
Cloudflared remain active with their existing loopback listeners.

Public, non-secret probes confirmed that the fixed Worker is reachable: an
invalid `GET` to connect returned Worker `405 METHOD_NOT_ALLOWED`, an invalid
credential request returned `401 PAPER_PROCESSOR_UNAUTHENTICATED`, and a
request to an unknown Processor path returned the same Worker authentication
boundary. The prior real Python connect attempt returned Cloudflare `403
Error 1010 browser_signature_banned` before the Worker handler. No retry or
header/User-Agent bypass was used.

Read-only Cloudflare checks identified account `3cfba3bb2ec69798aa4881b05d80810f`
and zone `zhangyvjing.com` (`a6954af7cee9fcecb610d087bdce3e01`), on the Free
Website plan. The current Wrangler session reports `zone(read)` but no
Rulesets/WAF management capability. Direct ruleset/Firewall reads returned
API error `10000 Authentication error`; settings reads for security controls
returned `9109 Unauthorized to access requested resource`. No rule was
created, changed, or read back as a write-side effect.

## Local contract amendment and gate result

The local amendment adds the non-secret `PAPER_PROCESSOR_SOURCE_IP` binding,
an application-level fail-closed source-IP and exact method/path gate, and a
versioned delivery-definition `edge_access` contract. The design and runbook
now require a zone-level custom `skip` limited to `products: ["bic"]`, the
fixed host, the fixed source IP, and the listed Processor method/path
families. They explicitly prohibit IP Access `Allow`, whole-host or wide-path
exceptions, skipping WAF/Bot Fight/security controls, and browser-signature
impersonation. Positive and negative tests cover the valid route, foreign
source IP, missing/wrong bootstrap secret, non-Processor paths, and the
delivery-definition fields.

The focused Edge tests passed 23/23, the full Edge check and test suite passed
128/128, Processor pytest passed 11/11, frontend typecheck/lint/unit passed
50/50, and frontend E2E passed 13/13 after the initial sandbox-only server
permission failure was rerun with the permitted local test-server capability.
No deployment, external secret/token, D1/R2 write, Redis change, or zhangbot
service change occurred in this subphase.

## External capability blocker

No Cloudflare exception was created. Two independent conditions prevent a safe
write:

1. The current Cloudflare credential cannot manage or read the required
   zone-level Rulesets/WAF rule, as shown by the read-only capability errors
   above.
2. The zone is Free. The strict dynamic-attempt-segment expression would need
   an exact regular-expression operator, but that operator is not available on
   this plan. A `wildcard` expression would be broader than the requested
   exact path/method/source-IP exception, even though the Worker application
   gate would reject malformed requests after the edge exception. It is not
   acceptable as the external exception under this card.

Therefore the status remains `BLOCKED_PROCESSOR_EDGE_ACCESS`. The precise next
capability is an authorized zone-level Rulesets/WAF session or token that can
create and read back a BIC-only custom skip rule, together with an approved
exact dynamic-path mechanism (for example a plan/capability that supports the
required regex semantics). If either cannot be provided, do not widen the
rule. The existing D1 migrations remain applied; no new Cloudflare rule,
secret, token, Processor release/service, or Edge deployment was left behind.
