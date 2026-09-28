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

echo "→ load demo KPIs"
curl -fsS -X POST "$API/api/v1/metrics/demo" -H "$AUTH" | jq -e '.imported.metrics == 6' >/dev/null

echo "→ dashboard"
curl -fsS "$API/api/v1/metrics/dashboard?days=30&bucket=week" -H "$AUTH" | jq -e '.kpis | length == 6' >/dev/null

echo "→ insights (the demo's injected incidents must be found)"
INSIGHTS=$(curl -fsS "$API/api/v1/metrics/insights?days=30" -H "$AUTH")
echo "$INSIGHTS" | jq '{summary, anomalies: [.anomalies[] | {metric, day, deviationPct, bad}]}'
for metric in "Revenue" "Support tickets" "Avg resolution time" "Customer satisfaction"; do
  echo "$INSIGHTS" | jq -e --arg m "$metric" '[.anomalies[] | select(.metric == $m and .bad)] | length >= 1' >/dev/null \
    || { echo "missing anomaly for $metric"; exit 1; }
done

echo "→ exports"
curl -fsS "$API/api/v1/metrics/export?format=xlsx&days=30" -H "$AUTH" -o "$TMP/report.xlsx"
[ "$(head -c 2 "$TMP/report.xlsx")" = "PK" ] || { echo "xlsx export is not a zip"; exit 1; }
curl -fsS "$API/api/v1/metrics/export?format=pdf&days=30" -H "$AUTH" -o "$TMP/report.pdf"
[ "$(head -c 5 "$TMP/report.pdf")" = "%PDF-" ] || { echo "pdf export is not a PDF"; exit 1; }

echo "✓ smoke test passed"
