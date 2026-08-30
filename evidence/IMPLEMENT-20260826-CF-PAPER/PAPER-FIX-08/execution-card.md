# PAPER-FIX-08 — Expired Processor lease recovery

Recover a stale fenced Paper Processor attempt before server-selected polling;
do not allow an OOM-killed Processor to leave a resource permanently hidden
from its replacement instance.
