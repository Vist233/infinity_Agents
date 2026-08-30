# PAPER-FIX-10 — Retry budget independent of expired attempts

Correct PAPER-FIX-09 so an expired fenced lease before the first terminal
download timeout does not consume the single permitted retry. The immutable
retry audit event, not processor-attempt count, is the retry authority.
