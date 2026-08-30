# PAPER-FIX-09 — One bounded download-timeout retry

Permit exactly one owner-scoped retry only for a terminal
`PAPER_PROCESSOR_DOWNLOAD_TIMEOUT`. Preserve the failed attempt and audit
history, then require the Processor to claim a higher fencing epoch. Do not
deploy, push, or modify any remote system in this card.
