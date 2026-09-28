#!/usr/bin/env bash
# End-to-end test of the Helm chart against the current kube context (a kind cluster in CI):
# install/upgrade -> wait for every rollout -> run the compose smoke test through a
# port-forward -> helm test. On failure it dumps pod state and logs before cleaning up.
#
# Expects the opsmind-{api,ai,web}:ci images to be loaded into the cluster already.
# Env: RELEASE, NAMESPACE, VALUES, TIMEOUT, LOCAL_PORT, KEEP=1 (leave the release installed).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE="${RELEASE:-opsmind}"
NAMESPACE="${NAMESPACE:-opsmind}"
CHART="${CHART:-$ROOT/deploy/helm/opsmind}"
VALUES="${VALUES:-$ROOT/deploy/kind/values-kind.yaml}"
TIMEOUT="${TIMEOUT:-10m}"
LOCAL_PORT="${LOCAL_PORT:-4000}"
KEEP="${KEEP:-0}"

SELECTOR="app.kubernetes.io/instance=$RELEASE"
PF_PID=""
PF_LOG="$(mktemp)"

kc() { kubectl -n "$NAMESPACE" "$@"; }

dump_diagnostics() {
  echo "::group::resources"
  kc get all,pvc,configmap,networkpolicy -o wide
  echo "::endgroup::"
  echo "::group::events"
  kc get events --sort-by=.lastTimestamp
  echo "::endgroup::"
  echo "::group::describe pods"
  kc describe pods -l "$SELECTOR"
  echo "::endgroup::"
  for pod in $(kc get pods -l "$SELECTOR" -o name); do
    echo "::group::logs $pod"
    kc logs "$pod" --all-containers --prefix --tail=300
    # Logs of the previous container instance explain crash loops.
    kc logs "$pod" --all-containers --prefix --previous --tail=100 2>/dev/null || true
    echo "::endgroup::"
  done
  echo "::group::port-forward log"
  cat "$PF_LOG"
  echo "::endgroup::"
}

cleanup() {
  local status=$?
  set +e
  if [ -n "$PF_PID" ]; then
    kill "$PF_PID" 2>/dev/null
    wait "$PF_PID" 2>/dev/null
  fi
  if [ "$status" -ne 0 ]; then
    echo "kind e2e failed (exit $status); collecting diagnostics" >&2
    dump_diagnostics
  fi
  if [ "$KEEP" != "1" ]; then
    helm uninstall "$RELEASE" -n "$NAMESPACE" >/dev/null 2>&1
    # The chart keeps its Secret on uninstall; the namespace delete takes it and the PVC along.
    kubectl delete namespace "$NAMESPACE" --wait=false >/dev/null 2>&1
  fi
  rm -f "$PF_LOG"
  exit "$status"
}
trap cleanup EXIT

echo "→ helm upgrade --install $RELEASE"
helm upgrade --install "$RELEASE" "$CHART" \
  --namespace "$NAMESPACE" --create-namespace \
  -f "$VALUES" \
  --wait --timeout "$TIMEOUT"

echo "→ rollout status"
workloads="$(kc get deployment,statefulset -l "$SELECTOR" -o name)"
[ -n "$workloads" ] || { echo "no workloads found for $SELECTOR" >&2; exit 1; }
for w in $workloads; do
  kc rollout status "$w" --timeout=5m
done
kc get pods -l "$SELECTOR" -o wide

echo "→ port-forward api to localhost:$LOCAL_PORT"
API_SVC="$(kc get svc -l "$SELECTOR,app.kubernetes.io/component=api" -o jsonpath='{.items[0].metadata.name}')"
API_SVC_PORT="$(kc get svc "$API_SVC" -o jsonpath='{.spec.ports[0].port}')"
kc port-forward "svc/$API_SVC" "$LOCAL_PORT:$API_SVC_PORT" >"$PF_LOG" 2>&1 &
PF_PID=$!

API="http://localhost:$LOCAL_PORT"
for i in $(seq 1 60); do
  kill -0 "$PF_PID" 2>/dev/null || { echo "port-forward exited" >&2; exit 1; }
  if curl -fsS "$API/ready" >/dev/null 2>&1; then
    echo "api ready after ${i}s"
    break
  fi
  [ "$i" -eq 60 ] && { echo "api not ready at $API/ready after 60s" >&2; exit 1; }
  sleep 1
done

echo "→ smoke test"
API="$API" bash "$ROOT/scripts/smoke.sh"

echo "→ helm test"
helm test "$RELEASE" -n "$NAMESPACE" --logs --timeout 3m

# Restarts during the run usually mean a probe or resource limit is wrong even if the test passed.
restarts="$(kc get pods -l "$SELECTOR" -o jsonpath='{range .items[*]}{.metadata.name}{" "}{range .status.containerStatuses[*]}{.restartCount}{" "}{end}{"\n"}{end}' \
  | awk '{ for (i = 2; i <= NF; i++) if ($i > 0) print $1 " restarted " $i "x" }')"
if [ -n "$restarts" ]; then
  echo "::warning::containers restarted during the e2e run:"
  echo "$restarts"
fi

echo "✓ kind e2e passed"
