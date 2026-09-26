#!/usr/bin/env bash
# End-to-end smoke test against a running stack (docker compose up):
# register -> upload -> wait for worker to index -> ask -> assert a cited answer.
set -euo pipefail

API="${API:-http://localhost:4000}"
EMAIL="smoke-$(date +%s)@example.com"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "→ register"
TOKEN=$(curl -fsS -X POST "$API/api/v1/auth/register" -H 'content-type: application/json' \
  -d "{\"tenantName\":\"Smoke Co\",\"name\":\"Smoke\",\"email\":\"$EMAIL\",\"password\":\"password123\"}" | jq -r .token)
AUTH="authorization: Bearer $TOKEN"

cat > "$TMP/policies.txt" <<'TXT'
Refund policy

Customers can request a full refund within 30 days of purchase.
After 30 days, only store credit is offered.

Shipping policy

Orders ship within 2 business days from our Kazan warehouse.
TXT

echo "→ upload"
DOC=$(curl -fsS -X POST "$API/api/v1/documents" -H "$AUTH" -F "file=@$TMP/policies.txt" | jq -r .id)

echo "→ wait for indexing ($DOC)"
for _ in $(seq 1 60); do
  STATUS=$(curl -fsS "$API/api/v1/documents/$DOC" -H "$AUTH" | jq -r .status)
  [ "$STATUS" = "ready" ] && break
  [ "$STATUS" = "failed" ] && { curl -fsS "$API/api/v1/documents/$DOC" -H "$AUTH" | jq .; exit 1; }
  sleep 1
done
[ "$STATUS" = "ready" ] || { echo "timed out (status=$STATUS)"; exit 1; }

echo "→ ask"
ANSWER=$(curl -fsS -X POST "$API/api/v1/ask" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"question":"How many days do customers have to request a refund?"}')
echo "$ANSWER" | jq .
echo "$ANSWER" | jq -e '.answer | test("30")' >/dev/null
echo "$ANSWER" | jq -e '[.citations[] | select(.cited)] | length > 0' >/dev/null

echo "✓ smoke test passed"
