#!/usr/bin/env bash
# Revoke ALL Worker enrollments on the control plane.
#
# Usage:
#   bash scripts/delete-all-workers.sh              # default localhost:8008
#   bash scripts/delete-all-workers.sh http://10.0.0.5:8008
set -euo pipefail

API_URL="${1:-http://localhost:8008}"

echo "==> Listing all Workers at $API_URL ..."
RESPONSE=$(curl -sS "$API_URL/api/worker-enrollments" 2>&1) || {
    echo "ERROR: Failed to reach API at $API_URL"
    echo "$RESPONSE"
    exit 1
}

# Parse workers from response
WORKERS=$(echo "$RESPONSE" | python3 -c "
import sys, json
data = json.loads(sys.stdin.read())
workers = data.get('workers', [])
if not workers:
    print('NONE')
else:
    for w in workers:
        print(w['worker_id'] + '|' + w.get('namespace', ''))
" 2>/dev/null)

if [ "$WORKERS" = "NONE" ]; then
    echo "No Workers found. Nothing to revoke."
    exit 0
fi

COUNT=$(echo "$WORKERS" | wc -l | tr -d ' ')
echo "Found $COUNT Worker(s):"
echo ""

REVOKED=0
FAILED=0

while IFS='|' read -r worker_id namespace; do
    echo "  Revoking: $worker_id (namespace: $namespace) ..."
    if curl -sS -X POST "$API_URL/api/worker-enrollments/$worker_id/revoke?namespace=$namespace" > /dev/null 2>&1; then
        echo "    -> Revoked"
        REVOKED=$((REVOKED + 1))
    else
        echo "    -> FAILED"
        FAILED=$((FAILED + 1))
    fi
done <<< "$WORKERS"

echo ""
echo "========================================="
echo " Done: $REVOKED revoked, $FAILED failed"
echo "========================================="
[ "$FAILED" -eq 0 ]
