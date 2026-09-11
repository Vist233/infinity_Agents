# D2 — Paper Catalog API using the existing Paper Resource pipeline

Date: 2026-09-11 (Asia/Shanghai)
Status: PASS (API/unit coverage; production processor E2E remains a later gate)

Added the authenticated Discovery Paper API. A PDF upload is bounded to 64
MiB, checked by PDF magic bytes, hashed before persistence, deduplicated per
owner, stored through the existing `putPaperObject(..., "source_pdf", ...)`
abstraction, and recorded as an existing Paper Resource linked to a dedicated
chat session. The new `paper_catalog` row remains private and `requested`
until the existing Paper Processor makes the resource ready.

List/detail/delete paths are owner-scoped, public-row compatible, and do not
return R2 object keys. Paper deletion marks the catalog/resource deleted and
uses the existing cleanup job for the source namespace; profile/overview keys
are exact-key cleanup only.
