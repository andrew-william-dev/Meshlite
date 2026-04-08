#!/usr/bin/env bash
# hack/dev-cluster.sh
#
# Creates the local kind cluster for MeshLite Phase 1 development.
# Run this once before any testing. Idempotent — safe to re-run.
#
# Usage:
#   ./hack/dev-cluster.sh
#   ./hack/dev-cluster.sh --cross-cluster   # also create cluster-1 and cluster-2

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

DEV_CLUSTER="meshlite-dev"
KIND_CONFIG="${SCRIPT_DIR}/kind-config.yaml"

# ── Helpers ───────────────────────────────────────────────────────────────────

log()  { echo "[dev-cluster] $*"; }
die()  { echo "[dev-cluster] ERROR: $*" >&2; exit 1; }

require() {
  command -v "$1" &>/dev/null || die "'$1' not found — install it first (see docs/phase1-runbook.md)"
}

# ── Preflight checks ──────────────────────────────────────────────────────────

require kind
require kubectl
require docker

# Docker must be running
docker info &>/dev/null || die "Docker is not running — start Docker Desktop first"

# ── Single dev cluster ────────────────────────────────────────────────────────

if kind get clusters 2>/dev/null | grep -q "^${DEV_CLUSTER}$"; then
  log "Cluster '${DEV_CLUSTER}' already exists — skipping creation"
else
  log "Creating kind cluster '${DEV_CLUSTER}' (1 control-plane + 2 workers)..."
  kind create cluster \
    --config "${KIND_CONFIG}" \
    --name "${DEV_CLUSTER}" \
    --wait 120s
  log "Cluster created."
fi

kubectl config use-context "kind-${DEV_CLUSTER}"

# ── Verify nodes are Ready ────────────────────────────────────────────────────

log "Waiting for all nodes to reach Ready state..."
kubectl wait node \
  --all \
  --for=condition=Ready \
  --timeout=120s

log ""
log "Cluster '${DEV_CLUSTER}' is ready:"
kubectl get nodes -o wide

# ── Deploy test services ──────────────────────────────────────────────────────

log ""
log "Deploying Phase 1 test services (service-alpha, service-beta)..."
kubectl apply -f "${REPO_ROOT}/tests/fixtures/test-services.yaml"

log "Waiting for test pods to be Running..."
kubectl wait deployment \
  -n meshlite-test \
  --all \
  --for=condition=Available \
  --timeout=120s

log ""
log "Test pods:"
kubectl get pods -n meshlite-test -o wide

# ── Cross-cluster setup (optional) ───────────────────────────────────────────

if [[ "${1:-}" == "--cross-cluster" ]]; then
  log ""
  log "Creating cross-cluster pair (cluster-1, cluster-2) for Phase 4..."

  for CNAME in cluster-1 cluster-2; do
    if kind get clusters 2>/dev/null | grep -q "^${CNAME}$"; then
      log "Cluster '${CNAME}' already exists — skipping"
    else
      log "Creating '${CNAME}'..."
      kind create cluster --name "${CNAME}" --wait 90s
    fi
  done

  log ""
  log "Cross-cluster contexts:"
  kubectl config get-contexts | grep -E "kind-cluster-[12]"
fi

# ── Summary ───────────────────────────────────────────────────────────────────

log ""
log "═══════════════════════════════════════════════════════"
log " Setup complete. Active context: $(kubectl config current-context)"
log ""
log " Next steps (Phase 1):"
log "   1. SSH into a worker node and run the kprobe loader"
log "   2. Generate traffic: kubectl exec -it deploy/service-alpha -n meshlite-test -- curl http://service-beta:8080"
log "   3. See docs/phase1-runbook.md for the full test procedure"
log "═══════════════════════════════════════════════════════"
