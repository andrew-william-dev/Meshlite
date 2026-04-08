#!/usr/bin/env bash
# hack/teardown.sh
#
# Removes all kind clusters created by dev-cluster.sh.
# WARNING: This deletes all local cluster state — not reversible.
#
# Usage:
#   ./hack/teardown.sh              # removes meshlite-dev only
#   ./hack/teardown.sh --all        # also removes cluster-1 and cluster-2

set -euo pipefail

log() { echo "[teardown] $*"; }

CLUSTERS=("meshlite-dev")

if [[ "${1:-}" == "--all" ]]; then
  CLUSTERS=("meshlite-dev" "cluster-1" "cluster-2")
fi

for CNAME in "${CLUSTERS[@]}"; do
  if kind get clusters 2>/dev/null | grep -q "^${CNAME}$"; then
    log "Deleting cluster '${CNAME}'..."
    kind delete cluster --name "${CNAME}"
    log "  Deleted."
  else
    log "Cluster '${CNAME}' does not exist — skipping"
  fi
done

log ""
log "Teardown complete. Remaining kind clusters:"
kind get clusters 2>/dev/null || log "  (none)"
