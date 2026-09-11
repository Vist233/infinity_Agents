# D5 — Data Collection backend and R2 storage

Date: 2026-09-11 (Asia/Shanghai)
Status: PASS (API/unit coverage; inspector persistence is D6)

Added the authenticated Data Collection API for one data file or one ZIP
archive. Uploads are bounded to 25 MiB, hash-checked from received bytes,
limited to CSV/TSV/JSON/TXT/README-style files or ZIP magic bytes, and stored
under a server-generated `datasets/{collection}/source/{safe_filename}` key.
The browser cannot choose an object key.

Collection metadata and status are stored in D1, duplicate uploads are
deduplicated per owner, private reads are owner-scoped, and delete marks the
row deleted then removes the exact source/profile objects. The data source is
not copied into a second task data plane; D10 will reference this object.
