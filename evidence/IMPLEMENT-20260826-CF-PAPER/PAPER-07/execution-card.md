# PAPER-07 execution card

- Branch: `cloudflare-deploy`
- Card: PAPER-07 — trusted PDF source admission, bounded download, parsing, and temporary-workspace recovery
- Baseline commit: `61adfab9d18e457b076ce8918afc9124124c3273`
- Scope: dedicated Paper Processor source admission and extraction, the additive D1 object-metadata migration, fixed logical object uploads, private user-PDF upload/input, and positive/negative regression tests.
- Out of scope: browser pagination/image APIs (PAPER-09), generic Agent tools (PAPER-08), deployment or remote resource operations (PAPER-10), and C7 public Worker/Redis/PostgreSQL paths.

## Acceptance

- [x] Canonical arXiv and eligible PMC references map to fixed HTTPS PDF endpoints; arbitrary approved URLs are rejected.
- [x] Every public fetch validates HTTPS, credentials/query/fragment absence, DNS results, allowed hosts, redirects, content type, PDF magic, bounded streaming size, and SHA-256.
- [x] Private uploads are bounded, checksum-verified, stored through the owned Edge resource route, and served only to the exact leased Processor attempt.
- [x] Dedicated Processor extraction uses `pypdf` for page/text admission and PyMuPDF for image extraction; it emits page text, image metadata, a manifest, and an image-only warning without publishing local paths.
- [x] Page/image counts, dimensions, per-image bytes, total image bytes, page count, malformed PDFs, encrypted PDFs, and non-PDF input fail closed.
- [x] Processor objects use fixed logical kinds and server-reconstructed storage paths; per-page/image metadata is additive and idempotent.
- [x] Temporary workspaces are removed on success, parser failure, transport failure, and restart recovery.
- [x] A failed processing attempt cannot finalize as ready; stale leases, duplicate claims, duplicate uploads, and cross-resource swaps are covered by regression tests.
- [x] Dedicated image contents contain no D1/R2/Redis/parent credentials and do not import the public Claude Worker runtime.
- [x] No deployment, remote D1 migration, remote R2 write, Processor registration, Redis ACL change, secret rotation, or Cloudflare configuration change was performed.
