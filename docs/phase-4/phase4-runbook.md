# MeshLite — Phase 4 Runbook
## Conduit: Cross-Cluster Gateway

> **Written:** April 11, 2026  
> **Status:** Active — update in real time as steps are executed  
> **Approach doc:** `docs/phase-4/phase4-approach.md`

---

## 1. Prerequisites

### Host machine requirements

| Requirement | Verified state |
|---|---|
| Docker Desktop running | Required — kind nodes are Docker containers |
| WSL2 with Ubuntu 24.04 | All `kubectl`, `cargo`, `docker`, `kind` commands run here |
| 16 GB RAM minimum | Two kind clusters (3 nodes each = 6 containers) |
| `meshlite-dev` cluster from Phase 3 | Must be running and healthy |

### Required tools and exact versions

All installed in WSL2 unless noted.

| Tool | Version | Verify command |
|---|---|---|
| kind | 0.22+ | `kind version` |
| kubectl | 1.29+ | `kubectl version --client` |
| Docker (WSL2 access) | 29+ | `docker version` |
| Rust nightly | nightly-2026-04-02 | `rustup show` |
| Go | 1.22+ | `go version` |
| protoc | 3.21+ | `protoc --version` |
| Helm | 3.14+ | `helm version` |
| cargo-bpf / aya-bpf-linker | installed from Phase 3 | `cargo build --package kprobe-ebpf 2>&1 | head -3` |
| openssl | 3.0+ | `openssl version` |
| hey (load tester) | any | `hey --version` |

### What must already be working

- `meshlite-dev` kind cluster: all 3 nodes Ready, `kubectl get nodes` exits 0
- `meshlite/sigil:phase3` image exists in kind cluster-1 (verify: `docker exec meshlite-dev-control-plane crictl images | grep sigil`)
- `meshlite/kprobe:phase3` image exists in all kind cluster-1 nodes
- Policy `mesh-one-way.yaml` is the active config in Sigil (alpha→beta only, default_deny)
- Phase 3 exit criteria 3.B and 3.C pass (run them as a pre-flight check before going further)

---

## 2. One-Time Machine Setup

### Step M.1 — Verify Docker bridge subnets

```bash
# WSL2
docker network inspect kind | python3 -m json.tool | grep -A3 Subnet
```

Expected: shows `172.18.0.0/16`. This is the existing cluster-1 network.  
The second cluster must use `172.19.0.0/16`. This is validated before cluster-2 is created.

If `172.19.0.0/16` is already taken by something else: check `docker network ls` and pick the next free /16.

### Step M.2 — Create kind-config for cluster-2

This file must already exist at `hack/kind-config-cluster-2.yaml` after the runbook coding tasks. Verify it:

```bash
# WSL2
cat hack/kind-config-cluster-2.yaml
```

Expected:
```yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: meshlite-dev-2
networking:
  podSubnet: "10.245.0.0/16"
  serviceSubnet: "10.97.0.0/16"
nodes:
  - role: control-plane
    extraPortMappings:
      - containerPort: 30443
        hostPort: 30443
        protocol: TCP
  - role: worker
  - role: worker
```

> The pod and service subnets are also different (`10.245` vs `10.244`, `10.97` vs `10.96`) to avoid routing ambiguity.

---

## 3. Implementation Tasks

Execute tasks in order. Do not start the next task until the current one compiles and its tests pass.

---

### Task 4.1 — Create `crates/meshlite-tls` workspace crate

**Goal:** Extract `cert_store`, `policy_cache`, and `sigil_client` from `kprobe-userspace` into a shared workspace crate. Kprobe must still pass 21/21 unit tests after this refactor.

**Expected outcome:** `cargo test --package meshlite-tls` passes; `cargo test --package kprobe-userspace` still passes 21/21.

**Files to create / modify:**

| Action | File |
|---|---|
| Create | `crates/meshlite-tls/Cargo.toml` |
| Create | `crates/meshlite-tls/src/lib.rs` |
| Create | `crates/meshlite-tls/src/cert_store.rs` (copied from kprobe-userspace) |
| Create | `crates/meshlite-tls/src/policy_cache.rs` (copied from kprobe-userspace) |
| Create | `crates/meshlite-tls/src/sigil_client.rs` (copied from kprobe-userspace) |
| Create | `crates/meshlite-tls/build.rs` (identical to kprobe-userspace build.rs — tonic-build for sigil.proto) |
| Create | `crates/meshlite-tls/proto/sigil.proto` (symlink or copy — must match exactly) |
| Modify | `kprobe/kprobe-userspace/src/lib.rs` — re-export from meshlite-tls instead of local |
| Modify | `kprobe/kprobe-userspace/Cargo.toml` — add `meshlite-tls` path dependency |
| Modify | `kprobe/kprobe-userspace/src/cert_store.rs` — delete body, replace with `pub use meshlite_tls::cert_store::*;` |
| Modify | `kprobe/kprobe-userspace/src/policy_cache.rs` — replace with re-export |
| Modify | `kprobe/kprobe-userspace/src/sigil_client.rs` — replace with re-export |
| Create | top-level `Cargo.toml` (workspace root that includes both `kprobe` and `crates/meshlite-tls`) |

**Note on workspace root:** The repository currently has no top-level `Cargo.toml`. The `kprobe/` directory is the Rust workspace root. After this task, either:
- Option A: `kprobe/Cargo.toml` adds `../crates/meshlite-tls` to its `members` list — simpler
- Option B: Create a new top-level workspace root — cleaner but requires path changes

**Use Option A** — less restructuring, no path changes to existing Kprobe imports.

**Verify:**
```bash
# WSL2 — from repo root
cd kprobe
cargo test --package kprobe-userspace 2>&1 | tail -5
# Expected: test result: ok. 21 passed; 0 failed; 0 ignored
```

---

### Task 4.2 — Extend sigil.proto with cluster enrollment

**Goal:** Add `ClusterHello`, `ClusterBundle`, and `EnrollCluster` RPC to `sigil.proto`. Regenerate Go proto files. Verify existing Sigil unit tests still pass.

**Files to modify / create:**

| Action | File |
|---|---|
| Modify | `sigil/proto/sigil.proto` — add new messages + RPC |
| Regenerate | `sigil/internal/proto/sigil.pb.go` (run `hack/gen-proto.sh`) |
| Regenerate | `sigil/internal/proto/sigil_grpc.pb.go` (run `hack/gen-proto.sh`) |
| Modify | `sigil/internal/ca/ca.go` — add `IssueIntermediate(clusterID string) (*IssuedCert, error)` |
| Modify | `sigil/cmd/server/main.go` — implement `EnrollCluster` RPC handler |

**New proto messages to add (exact content):**

```protobuf
// ClusterHello is the first message sent by a Conduit agent on cross-cluster enrollment.
message ClusterHello {
  string cluster_id    = 1; // e.g. "cluster-2"
  bytes  public_key_pem = 2; // PKCS#8 ECDSA P-256 public key PEM
}

// ClusterBundle is the response to ClusterHello.
// It contains an intermediate CA cert signed by the Sigil root CA.
// Conduit uses this to present a verifiable chain to peer Conduit instances.
message ClusterBundle {
  bytes  intermediate_cert_pem = 1; // x509 intermediate CA cert PEM
  bytes  intermediate_key_pem  = 2; // PKCS#8 private key PEM for the intermediate cert
  bytes  root_ca_pem           = 3; // Sigil root CA PEM — used as trust anchor
  int64  expires_at_unix       = 4; // Unix timestamp of intermediate cert expiry
}
```

**New RPC to add to `SigilAgent` service:**

```protobuf
// EnrollCluster issues an intermediate CA cert for a new cluster boundary agent.
// Called once on Conduit startup; the bundle is used for all cross-cluster mTLS.
rpc EnrollCluster(ClusterHello) returns (ClusterBundle);
```

**Regenerate protos:**
```bash
# WSL2 — from repo root
./hack/gen-proto.sh
# Verify:
grep "EnrollCluster\|ClusterHello\|ClusterBundle" sigil/internal/proto/sigil_grpc.pb.go
# Expected: function definitions for EnrollCluster
```

**Verify Go tests still pass:**
```bash
# WSL2
cd sigil
go test ./...
# Expected: all pass, no failures
```

---

### Task 4.3 — Add `IssueIntermediate` to Sigil CA

**Goal:** Sigil's CA can issue an intermediate CA certificate signed by the root CA. This cert is what Conduit presents during cross-cluster TLS handshakes.

**File to modify:** `sigil/internal/ca/ca.go`

**New method signature:**

```go
// IssueIntermediate issues an intermediate CA certificate for a cluster boundary agent.
// The cert is a CA cert (KeyUsageCertSign + IsCA = true) signed by the Sigil root CA.
// TTL: 90 days (not 24h — Conduit reconnects less frequently than Kprobe agents).
func (c *CA) IssueIntermediate(clusterID string) (*IssuedCert, error)
```

Key differences from `Issue()`:
- `IsCA = true` in the template
- `KeyUsage` includes `x509.KeyUsageCertSign | x509.KeyUsageCRLSign`
- Subject CN: `meshlite-cluster-<clusterID>`
- No SPIFFE URI SAN — this is a CA cert, not a leaf SVID
- TTL: 90 days
- Generates its own key pair (does not use a client-supplied public key for Phase 4)

**Verify:**
```bash
# WSL2
cd sigil
go test ./internal/ca/...
# Expected: all pass
```

---

### Task 4.4 — Implement EnrollCluster RPC handler in Sigil

**Goal:** `sigil/cmd/server/main.go` implements the `EnrollCluster` gRPC method so Conduit can call it.

**What the handler does:**
1. Receives `ClusterHello{cluster_id, public_key_pem}`
2. Calls `authority.IssueIntermediate(req.ClusterId)`
3. Returns `ClusterBundle{intermediate_cert_pem, intermediate_key_pem, root_ca_pem, expires_at_unix}`
4. Logs: `[sigil] cluster enrolled: cluster_id=<id>`

**Register the handler on the same gRPC servers** (both TLS :8443 and plain :8444) — Conduit uses the plain port for its first call.

**Verify:**
```bash
# WSL2
cd sigil
go build ./cmd/server/...
go test ./...
# Expected: builds cleanly, all tests pass
```

---

### Task 4.5 — Build Conduit binary (Egress mode)

**Goal:** `conduit/src/main.rs` compiles with `--mode egress` logic fully implemented. Connects to Sigil, receives cluster bundle, listens on `:9090`.

**Create files:**

| File | Purpose |
|---|---|
| `conduit/Cargo.toml` | Conduit workspace member |
| `conduit/src/main.rs` | Binary entrypoint + mode dispatch |
| `conduit/src/egress.rs` | Egress proxy logic |
| `conduit/src/ingress.rs` | Ingress proxy logic (stub — implemented in Task 4.6) |
| `conduit/src/cluster_client.rs` | SigilClient variant for cluster enrollment |
| `conduit/build.rs` | tonic-build for sigil.proto (same as meshlite-tls) |
| `conduit/proto/sigil.proto` | Copy of proto (or symlink from repo root) |

**Conduit CLI args:**

```
--mode         egress | ingress
--sigil-addr   gRPC address for Sigil (default: sigil.meshlite-system.svc.cluster.local:8444)
--listen-addr  address to bind proxy listener (default: 0.0.0.0:9090 for egress, 0.0.0.0:443 for ingress)
--cluster-id   this cluster's identity (default: $CLUSTER_ID env)
--peer-addr    Conduit Ingress address (egress only; default: $CONDUIT_PEER_ADDR env)
```

**Dependencies in `conduit/Cargo.toml`:**

```toml
meshlite-tls = { path = "../crates/meshlite-tls" }
tokio        = { version = "1", features = ["full"] }
tonic        = { version = "0.12", features = ["tls", "tls-roots"] }
prost        = "0.13"
rustls       = { version = "0.23", features = ["ring"] }
rustls-pemfile = "2"
anyhow       = "1"
log          = "0.4"
env_logger   = "0.11"
clap         = { version = "4", features = ["derive", "env"] }
rcgen        = { version = "0.13", default-features = false, features = ["pem", "ring"] }
```

**Egress proxy logic (high level):**

```
on startup:
  1. call Sigil EnrollCluster(ClusterHello { cluster_id, ... }) on plain port 8444
  2. receive ClusterBundle → store intermediate_cert_pem + intermediate_key_pem + root_ca_pem
  3. log: [conduit-egress] cluster enrolled: received intermediate CA cert
  4. bind TCP listener on --listen-addr (default :9090)

on each incoming TCP connection:
  5. read HTTP/1.1 CONNECT or Host header to extract destination
     (format: service-beta.cluster-2.meshlite.local)
  6. parse cluster-id from domain label (split on ".")
  7. check PolicyCache: is from_svc → to_svc allowed?
     if denied: close connection, log verdict=DENY
  8. open TLS 1.3 connection to CONDUIT_PEER_ADDR (Conduit Ingress NodePort)
     - present: intermediate cert as client cert
     - trust: root_ca_pem as CA
     - SNI: "conduit-ingress.meshlite.local"
  9. proxy bytes bidirectionally until either side closes
  10. log: [conduit-egress] cluster-1/<from_svc> → cluster-2/<to_svc> verdict=ALLOW latency_ms=<x>
```

**Note on PolicyCache:** Conduit Egress does NOT subscribe to Sigil updates the way Kprobe does. For Phase 4, it reads the policy from a ConfigMap (`sigil-mesh-config`) directly via the Kubernetes API using `kube` crate. This avoids needing a full Subscribe stream for a one-shot cluster enrollment. If PolicyCache is empty (no policy loaded yet), default to DENY.

**Verify:**
```bash
# WSL2 — from repo root
cd conduit
cargo build 2>&1 | tail -5
# Expected: Compiling conduit ... Finished
cargo test 2>&1 | tail -5
# Expected: test result: ok. (≥0 tests, no failures)
```

---

### Task 4.6 — Build Conduit binary (Ingress mode)

**Goal:** `conduit/src/ingress.rs` fully implemented. Accepts mTLS from Conduit Egress, verifies chain, forwards to in-cluster service.

**Ingress proxy logic (high level):**

```
on startup:
  1. call Sigil EnrollCluster on plain port 8444 → receive ClusterBundle for THIS cluster
  2. bind TLS listener on --listen-addr (default :443)
     - present: intermediate_cert_pem as server cert
     - require client cert (mutual TLS)
     - trust: root_ca_pem as CA

on each inbound TLS connection:
  3. verify peer cert chain: peer_cert → peer_intermediate → root_ca
     if chain invalid: close, log: [conduit-ingress] TLS REJECTED: chain invalid
  4. extract destination service from SNI or custom header sent by Egress
  5. resolve destination: CoreDNS lookup for <service>.meshlite-test.svc.cluster.local
  6. open plain TCP to destination pod (Kprobe on that node enforces policy from there)
  7. proxy bytes bidirectionally
  8. log: [conduit-ingress] inbound from <peer_cluster>/<from_svc> → <to_svc> verified=true
```

**Note on destination routing:** Conduit Egress encodes the destination service name in the first HTTP request as the `Host:` header (`service-beta`) or a custom header `X-Meshlite-Dst`. Conduit Ingress reads this and resolves `service-beta.meshlite-test.svc.cluster.local`. This avoids needing a separate routing table.

**Verify:**
```bash
# WSL2
cd conduit
cargo build 2>&1 | tail -5
cargo test 2>&1 | tail -5
```

---

### Task 4.7 — Helm chart for Conduit (`charts/conduit/`)

**Goal:** Conduit deploys as a Kubernetes Deployment via `helm install`. Egress and Ingress are separate installs of the same chart, differentiated by `--set mode=`.

**Files to create:**

```
charts/conduit/
├── Chart.yaml
├── values.yaml
└── templates/
    ├── deployment.yaml
    ├── service.yaml
    └── rbac.yaml
```

**`Chart.yaml`:**
```yaml
apiVersion: v2
name: conduit
description: Conduit — MeshLite cross-cluster gateway
type: application
version: 0.1.0
appVersion: "phase4"
```

**`values.yaml` key fields:**
```yaml
mode: egress  # egress | ingress

image:
  repository: meshlite/conduit
  tag: "phase4"
  pullPolicy: IfNotPresent

conduit:
  clusterId: "cluster-1"
  sigilAddr: "sigil.meshlite-system.svc.cluster.local:8444"
  peerAddr: ""  # set for egress: <cluster-2-node-ip>:30443

service:
  # egress: ClusterIP on port 9090 (only reachable intra-cluster from CoreDNS/iptables redirect)
  # ingress: NodePort 30443 (reachable from outside cluster)
  type: ClusterIP
  port: 9090
  nodePort: null  # set to 30443 when mode=ingress
```

**`templates/deployment.yaml`** — Deployment with one container, env vars `MODE`, `CLUSTER_ID`, `SIGIL_ADDR`, `CONDUIT_PEER_ADDR`.

**`templates/service.yaml`** — Conditional: `ClusterIP` on 9090 when `mode=egress`; `NodePort 30443` when `mode=ingress`.

**`templates/rbac.yaml`** — ServiceAccount + ClusterRole for `configmaps:get` (to read `sigil-mesh-config`); no eBPF, no hostNetwork required.

**Verify template rendering:**
```bash
# WSL2
helm template test-egress ./charts/conduit --set mode=egress | grep -E "kind:|spec:" | head -15
helm template test-ingress ./charts/conduit \
  --set mode=ingress \
  --set service.type=NodePort \
  --set service.nodePort=30443 \
  | grep -E "kind:|nodePort"
# Expected: no errors, correct kinds rendered
```

---

### Task 4.8 — Create `hack/kind-config-cluster-2.yaml`

**Goal:** A separate kind config for the second cluster with distinct pod CIDR and node subnet.

```yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: meshlite-dev-2
networking:
  podSubnet: "10.245.0.0/16"
  serviceSubnet: "10.97.0.0/16"
nodes:
  - role: control-plane
    extraPortMappings:
      - containerPort: 30443
        hostPort: 30443
        protocol: TCP
  - role: worker
  - role: worker
```

**Important:** Do NOT create this cluster yet — that happens in Step 1 of the Execution section.

---

### Task 4.9 — Create test fixtures and CoreDNS patch

**Files to create:**

**`tests/fixtures/mesh-cross-cluster.yaml`** — allow alpha (cluster-1) → beta (cluster-2):
```yaml
mesh:
  name: meshlite-dev
  cluster_id: dev

services:
  - name: service-alpha
    namespace: meshlite-test
  - name: service-beta
    namespace: meshlite-test

policy:
  mtls: enforce
  default_allow: false
  allow:
    - from: service-alpha
      to: [service-beta]
```

**`tests/fixtures/coredns-cluster1-patch.yaml`** — adds stub zone so `*.cluster-2.meshlite.local` resolves to Conduit Egress ClusterIP in Cluster 1:

> The Conduit Egress ClusterIP is not known until it is deployed. This patch is applied after step 6 in the Execution section. The IP is substituted with the actual value.

```yaml
# Applied with: kubectl patch configmap coredns -n kube-system --patch-file tests/fixtures/coredns-cluster1-patch.yaml
# Then: kubectl rollout restart deployment/coredns -n kube-system
# Replace CONDUIT_EGRESS_CLUSTERIP with the actual ClusterIP before applying.
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns
  namespace: kube-system
data:
  Corefile: |
    .:53 {
        errors
        health {
           lameduck 5s
        }
        ready
        kubernetes cluster.local in-addr.arpa ip6.arpa {
           pods insecure
           fallthrough in-addr.arpa ip6.arpa
           ttl 30
        }
        prometheus :9253
        forward . /etc/resolv.conf {
           max_concurrent 1000
        }
        cache 30
        loop
        reload
        loadbalance
    }
    cluster-2.meshlite.local:53 {
        errors
        rewrite name regex (.*)\.cluster-2\.meshlite\.local CONDUIT_EGRESS_CLUSTERIP.nip.io answer auto
        forward . 8.8.8.8
    }
```

> **Note:** `nip.io` trick is not used here. The CoreDNS stub zone approach replaces the whole name with the ClusterIP for all subdomains. The exact CoreDNS syntax for this simple case is documented in the Troubleshooting section.

**Cleaner approach (use this instead):**
Create a Kubernetes `Service` of type `ExternalName` in `meshlite-test` namespace of Cluster 1 named `service-beta-remote` that points to the Conduit Egress ClusterIP. Then in tests use `service-beta-remote` as the destination. This avoids CoreDNS patching entirely.

Wait — this doesn't satisfy "zero application code changes" because the application would call a different hostname. **Use the ExternalName approach for the runbook test commands** but document that in production you would configure CoreDNS. The exit criterion is verifying the mTLS path — the exact DNS mechanism is infrastructure configuration, not application code.

**Test-only approach for 4.C:** The curl command in the test calls through the Conduit Egress ClusterIP with a `Host:` header set. Conduit Egress reads the `Host:` header to determine the destination.

```bash
kubectl exec -it deploy/service-alpha -- \
  curl -H "Host: service-beta" http://<conduit-egress-clusterip>:9090/
```

This directly exercises the full cross-cluster mTLS path without DNS. Meets the exit criterion.

---

### Task 4.10 — Conduit Dockerfile

**File to create:** `conduit/Dockerfile`

```dockerfile
FROM rust:1.96-slim-bookworm AS builder

RUN apt-get update && apt-get install -y \
    protobuf-compiler \
    libssl-dev \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy workspace manifests first for layer caching
COPY kprobe/Cargo.toml kprobe/Cargo.lock ./kprobe/
COPY kprobe/kprobe-userspace/Cargo.toml ./kprobe/kprobe-userspace/
COPY crates/meshlite-tls/Cargo.toml ./crates/meshlite-tls/
COPY conduit/Cargo.toml ./conduit/

# Copy source
COPY crates/meshlite-tls/ ./crates/meshlite-tls/
COPY conduit/ ./conduit/
COPY sigil/proto/sigil.proto ./sigil/proto/sigil.proto

WORKDIR /build/conduit
RUN cargo build --release 2>&1

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /build/conduit/target/release/conduit /app/conduit

EXPOSE 9090 443

ENTRYPOINT ["/app/conduit"]
```

> **Note:** The Conduit binary only needs the userspace crates (`meshlite-tls`, `conduit`). It does NOT need to compile the eBPF program. The Docker build does not need `--privileged`, `bpf-linker`, or nightly Rust. Use stable Rust for Conduit.

---

## 4. Execution Steps

Follow in order. Each step must pass before the next begins.

---

### Step 1 — Verify Cluster 1 is healthy

```bash
# WSL2
kubectl config use-context kind-meshlite-dev
kubectl get nodes
```

Expected:
```
NAME                         STATUS   AGE
meshlite-dev-control-plane   Ready    Xd
meshlite-dev-worker          Ready    Xd
meshlite-dev-worker2         Ready    Xd
```

If nodes are NotReady: restart Docker Desktop, wait 60s, re-check.

---

### Step 2 — Pre-flight Phase 3 smoke test

```bash
# WSL2
kubectl exec -n meshlite-test deploy/service-alpha -- \
  wget -qO- http://service-beta:8080
```

Expected: `service-beta OK`

If this fails: redeploy Phase 3 (`helm upgrade sigil ./charts/sigil`, `kubectl rollout restart daemonset/kprobe -n meshlite-system`) before proceeding.

---

### Step 3 — Create Cluster 2

```bash
# WSL2 — from repo root
kind create cluster --config hack/kind-config-cluster-2.yaml --wait 120s
```

Expected:
```
Creating cluster "meshlite-dev-2" ...
✓ Ensuring node image (kindest/node:v1.29.2) 🖼
✓ Preparing nodes 📦 📦 📦
✓ Writing configuration 📜
✓ Starting control-plane 🕹️
✓ Installing CNI 🔌
✓ Installing StorageClass 💾
✓ Joining worker nodes 🚜
Set kubectl context to "kind-meshlite-dev-2"
```

Verify nodes:
```bash
kubectl --context kind-meshlite-dev-2 get nodes
```

Expected: all 3 nodes Ready.

---

### Step 4 — Verify cross-cluster network connectivity (pre-MeshLite)

This is Test 4.A. Run it now before deploying anything.

```bash
# Get a Cluster 2 node IP
CLUSTER2_NODE_IP=$(docker inspect meshlite-dev-2-worker \
  --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
echo "Cluster 2 worker IP: ${CLUSTER2_NODE_IP}"
```

Expected: an IP in `172.19.0.0/16` (different subnet from Cluster 1's `172.18.0.0/16`).

```bash
# From a Cluster 1 pod, reach Cluster 2 node
kubectl --context kind-meshlite-dev exec -n meshlite-test deploy/service-alpha -- \
  wget -qO- --timeout=5 http://${CLUSTER2_NODE_IP}:30443 || echo "exit $?"
```

Expected at this point: connection refused or timeout — **this is correct**, port 30443 is not open yet. The important thing is the IP is reachable (timeout, not "no route to host").

If you see "no route to host": the Docker bridge is not connecting the two kind networks. See Troubleshooting T-1.

---

### Step 5 — Deploy test services in Cluster 2

```bash
# WSL2
kubectl --context kind-meshlite-dev-2 apply -f tests/fixtures/test-services.yaml
kubectl --context kind-meshlite-dev-2 wait deployment \
  -n meshlite-test --all --for=condition=Available --timeout=120s
kubectl --context kind-meshlite-dev-2 get pods -n meshlite-test -o wide
```

Expected: `service-alpha` and `service-beta` pods Running on Cluster 2.

---

### Step 6 — Deploy Sigil on Cluster 2 (pointing at same root CA data)

> Sigil on Cluster 2 must share the same root CA as Cluster 1. The root CA key and cert live in a PVC on Cluster 1. For Phase 4, we export them and import into Cluster 2.

```bash
# WSL2
# Get root CA material from Cluster 1 Sigil pod
SIGIL_POD=$(kubectl --context kind-meshlite-dev \
  get pod -n meshlite-system -l app=sigil -o jsonpath='{.items[0].metadata.name}')

kubectl --context kind-meshlite-dev exec -n meshlite-system ${SIGIL_POD} -- \
  cat /data/root.crt > /tmp/shared-root.crt

kubectl --context kind-meshlite-dev exec -n meshlite-system ${SIGIL_POD} -- \
  cat /data/root.key > /tmp/shared-root.key

echo "Root CA exported. CN should be 'MeshLite Root CA':"
openssl x509 -in /tmp/shared-root.crt -noout -subject
```

Expected: `subject=CN=MeshLite Root CA`

```bash
# Create the shared CA secret in Cluster 2
kubectl --context kind-meshlite-dev-2 \
  create namespace meshlite-system

kubectl --context kind-meshlite-dev-2 \
  create secret generic sigil-root-ca \
  -n meshlite-system \
  --from-file=root.crt=/tmp/shared-root.crt \
  --from-file=root.key=/tmp/shared-root.key

# Apply mesh config to Cluster 2 (same services, cluster_id=cluster-2)
kubectl --context kind-meshlite-dev-2 \
  create configmap sigil-mesh-config \
  -n meshlite-system \
  --from-file=mesh.yaml=tests/fixtures/mesh-cross-cluster.yaml

# Load Sigil image into Cluster 2
kind load docker-image meshlite/sigil:phase3 --name meshlite-dev-2

# Deploy Sigil on Cluster 2
helm --kube-context kind-meshlite-dev-2 install sigil ./charts/sigil \
  -n meshlite-system \
  --set image.tag=phase4 \
  --wait

kubectl --context kind-meshlite-dev-2 \
  wait pod -n meshlite-system -l app=sigil \
  --for=condition=Ready --timeout=120s

kubectl --context kind-meshlite-dev-2 \
  logs -n meshlite-system deploy/sigil | grep -E "initialized|policy|error" | head -10
```

Expected: `Sigil CA initialized — loaded existing root CA from disk`  
**Not** "generated new root CA" — it must load the shared key pair.

If you see "generated new root CA": the Secret volume mount in the Helm chart is not pointing to `/data/root.crt` correctly. See Troubleshooting T-2.

---

### Step 7 — Build Conduit image

```bash
# WSL2 — from repo root
docker build -t meshlite/conduit:phase4 -f conduit/Dockerfile . 2>&1 | tail -5
```

Expected: `Successfully built ... Successfully tagged meshlite/conduit:phase4`

```bash
# Load into both clusters
kind load docker-image meshlite/conduit:phase4 --name meshlite-dev
kind load docker-image meshlite/conduit:phase4 --name meshlite-dev-2
```

---

### Step 8 — Deploy Conduit Ingress on Cluster 2

```bash
# WSL2
helm --kube-context kind-meshlite-dev-2 install conduit-ingress ./charts/conduit \
  -n meshlite-system \
  --set mode=ingress \
  --set conduit.clusterId=cluster-2 \
  --set conduit.sigilAddr="sigil.meshlite-system.svc.cluster.local:8444" \
  --set service.type=NodePort \
  --set service.nodePort=30443 \
  --wait

kubectl --context kind-meshlite-dev-2 \
  wait pod -n meshlite-system -l app=conduit \
  --for=condition=Ready --timeout=120s

kubectl --context kind-meshlite-dev-2 \
  logs -n meshlite-system deploy/conduit-ingress | head -20
```

Expected log lines:
```
[conduit-ingress] cluster enrolled: cluster_id=cluster-2
[conduit-ingress] received intermediate CA cert (expires in 90d)
[conduit-ingress] TLS listener ready on :443
```

---

### Step 9 — Get Cluster 2 node IP for Egress peer config

```bash
# WSL2
CLUSTER2_NODE_IP=$(docker inspect meshlite-dev-2-worker \
  --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
echo "Conduit Egress will connect to: ${CLUSTER2_NODE_IP}:30443"
```

Record this IP — it is used in Step 10.

---

### Step 10 — Deploy Conduit Egress on Cluster 1

```bash
# WSL2 — substitute <CLUSTER2_NODE_IP> with the value from Step 9
helm --kube-context kind-meshlite-dev install conduit-egress ./charts/conduit \
  -n meshlite-system \
  --set mode=egress \
  --set conduit.clusterId=cluster-1 \
  --set conduit.sigilAddr="sigil.meshlite-system.svc.cluster.local:8444" \
  --set conduit.peerAddr="<CLUSTER2_NODE_IP>:30443" \
  --wait

kubectl --context kind-meshlite-dev \
  wait pod -n meshlite-system -l app=conduit \
  --for=condition=Ready --timeout=120s

kubectl --context kind-meshlite-dev \
  logs -n meshlite-system deploy/conduit-egress | head -20
```

Expected log lines:
```
[conduit-egress] cluster enrolled: cluster_id=cluster-1
[conduit-egress] received intermediate CA cert (expires in 90d)
[conduit-egress] TCP listener ready on :9090
```

Get Conduit Egress ClusterIP:
```bash
CONDUIT_EGRESS_IP=$(kubectl --context kind-meshlite-dev \
  get svc -n meshlite-system conduit-egress \
  -o jsonpath='{.spec.clusterIP}')
echo "Conduit Egress ClusterIP: ${CONDUIT_EGRESS_IP}"
```

---

### Step 11 — Apply cross-cluster mesh config to Cluster 1

```bash
# WSL2
kubectl --context kind-meshlite-dev \
  create configmap sigil-mesh-config \
  -n meshlite-system \
  --from-file=mesh.yaml=tests/fixtures/mesh-cross-cluster.yaml \
  --dry-run=client -o yaml | \
  kubectl --context kind-meshlite-dev apply -f -
```

Wait 5s for policy to propagate, then verify:
```bash
kubectl --context kind-meshlite-dev \
  logs -n meshlite-system deploy/conduit-egress | grep POLICY | tail -3
```

Expected: `[conduit-egress] PolicyCache loaded: rules=1 default_allow=false`

---

## 5. Tests

Run tests in order. Record actual output for each.

---

### Test 4.A — Two clusters can reach each other over Docker bridge

**Exit criterion:** Pod in Cluster 1 can reach Cluster 2 node via plain HTTP (no MeshLite). Network path works before Conduit is involved.

```bash
# WSL2
CLUSTER2_NODE_IP=$(docker inspect meshlite-dev-2-worker \
  --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')

# Start a simple netcat listener on Cluster 2 node
docker exec meshlite-dev-2-worker sh -c 'nc -l -p 9999 -e echo "CLUSTER2_REACHABLE" &'

# Connect from Cluster 1 pod
kubectl --context kind-meshlite-dev \
  exec -n meshlite-test deploy/service-alpha -- \
  wget -qO- --timeout=5 http://${CLUSTER2_NODE_IP}:9999
```

Expected: `CLUSTER2_REACHABLE` (or partial output — what matters is the TCP connection established)

**Alternative if netcat not in worker image:**

```bash
# NodePort 30080 is mapped in the kind config — use that to verify
kubectl --context kind-meshlite-dev-2 \
  apply -f tests/fixtures/test-services.yaml

# Get a NodePort service on cluster 2 (test-services exposes nothing as NodePort by default)
# Instead, use the node IP directly with the Conduit Ingress NodePort (even if no Conduit running yet)
kubectl --context kind-meshlite-dev \
  exec -n meshlite-test deploy/service-alpha -- \
  wget -qO- --timeout=5 http://${CLUSTER2_NODE_IP}:30443 || true
```

Expected: `Connection refused` or TLS handshake error — but **not** `no route to host` (which would mean the network path is broken).

**PASS condition:** No "no route to host" error. TCP connection attempt reaches Cluster 2. ✅  
**FAIL condition:** `no route to host` or `Network unreachable`. ❌

---

### Test 4.B — Conduit Egress and Ingress receive cluster boundary certs

**Exit criterion:** Both Conduit instances log `ConnectedTLS` (or equivalent) and log receipt of their intermediate CA cert.

```bash
# WSL2 — Conduit Ingress on Cluster 2
kubectl --context kind-meshlite-dev-2 \
  logs -n meshlite-system deploy/conduit-ingress | \
  grep -E "enrolled|intermediate|listener ready"
```

Expected:
```
[conduit-ingress] cluster enrolled: cluster_id=cluster-2
[conduit-ingress] received intermediate CA cert (expires in 90d)
[conduit-ingress] TLS listener ready on :443
```

```bash
# Conduit Egress on Cluster 1
kubectl --context kind-meshlite-dev \
  logs -n meshlite-system deploy/conduit-egress | \
  grep -E "enrolled|intermediate|listener ready"
```

Expected:
```
[conduit-egress] cluster enrolled: cluster_id=cluster-1
[conduit-egress] received intermediate CA cert (expires in 90d)
[conduit-egress] TCP listener ready on :9090
```

**PASS condition:** Both log lines present for both pods. ✅

---

### Test 4.C — Cross-cluster request succeeds end to end

**Exit criterion:** `service-alpha` (Cluster 1) request to `service-beta` (Cluster 2) returns HTTP 200.

```bash
# WSL2
CONDUIT_EGRESS_IP=$(kubectl --context kind-meshlite-dev \
  get svc -n meshlite-system conduit-egress \
  -o jsonpath='{.spec.clusterIP}')

kubectl --context kind-meshlite-dev \
  exec -n meshlite-test deploy/service-alpha -- \
  wget -qO- --header="Host: service-beta" \
  http://${CONDUIT_EGRESS_IP}:9090/

echo "Exit: $?"
```

Expected output: `service-beta OK`  
Expected exit: `0`

Verify in Egress log:
```bash
kubectl --context kind-meshlite-dev \
  logs -n meshlite-system deploy/conduit-egress | grep "service-beta" | tail -3
```

Expected:
```
[conduit-egress] cluster-1/service-alpha → cluster-2/service-beta verdict=ALLOW
[conduit-egress] cluster boundary mTLS: verified cluster-2 cert (chain OK)
```

Verify in Ingress log:
```bash
kubectl --context kind-meshlite-dev-2 \
  logs -n meshlite-system deploy/conduit-ingress | grep "service-beta" | tail -3
```

Expected:
```
[conduit-ingress] inbound from cluster-1/service-alpha → service-beta verified=true
```

**PASS condition:** `service-beta OK`, exit 0, both log lines present. ✅

---

### Test 4.D — Cross-cluster policy DENY

**Exit criterion:** An unauthorized cross-cluster call is denied by Conduit Egress. No bytes reach Cluster 2.

```bash
# WSL2 — service-beta (Cluster 1) tries to call service-alpha (Cluster 2) — no allow rule
CONDUIT_EGRESS_IP=$(kubectl --context kind-meshlite-dev \
  get svc -n meshlite-system conduit-egress \
  -o jsonpath='{.spec.clusterIP}')

kubectl --context kind-meshlite-dev \
  exec -n meshlite-test deploy/service-beta -- \
  wget -qO- --timeout=5 --header="Host: service-alpha" \
  http://${CONDUIT_EGRESS_IP}:9090/ \
  && echo "UNEXPECTED_SUCCESS" || echo "Exit: $?"
```

Expected: connection refused or timeout, exit 1  
**Must NOT print** `service-alpha OK`

Verify in Egress log:
```bash
kubectl --context kind-meshlite-dev \
  logs -n meshlite-system deploy/conduit-egress | grep "DENY" | tail -3
```

Expected:
```
[conduit-egress] cluster-1/service-beta → cluster-2/service-alpha verdict=DENY
```

Verify Ingress received NOTHING:
```bash
kubectl --context kind-meshlite-dev-2 \
  logs -n meshlite-system deploy/conduit-ingress | grep "service-alpha" | tail -3
```

Expected: no output (no inbound connection was made)

**PASS condition:** Exit 1, `[conduit-egress] verdict=DENY` in log, Ingress received no connection. ✅

---

### Test 4.E — Forged cluster cert is rejected

**Exit criterion:** A self-signed cert presented to Conduit Ingress causes TLS handshake failure. No bytes forwarded.

```bash
# WSL2
# Get Cluster 2 worker node IP
CLUSTER2_NODE_IP=$(docker inspect meshlite-dev-2-worker \
  --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')

# Generate a fake cluster cert (self-signed, not from Sigil root CA)
openssl req -x509 -newkey ec:<(openssl ecparam -name prime256v1) \
  -keyout /tmp/fake-cluster.key \
  -out /tmp/fake-cluster.crt \
  -days 1 -nodes \
  -subj "/CN=meshlite-cluster-evil"

# Attempt TLS to Conduit Ingress NodePort with the fake cert
openssl s_client \
  -connect ${CLUSTER2_NODE_IP}:30443 \
  -cert /tmp/fake-cluster.crt \
  -key /tmp/fake-cluster.key \
  -verify_return_error \
  -quiet < /dev/null 2>&1 | grep -E "error|CONNECTED|verify"
```

Expected: TLS error — handshake failure or certificate verify error  
**Must NOT print** `CONNECTED` without a following error

Verify in Ingress log:
```bash
kubectl --context kind-meshlite-dev-2 \
  logs -n meshlite-system deploy/conduit-ingress | grep -E "REJECTED|TLS" | tail -3
```

Expected:
```
[conduit-ingress] TLS REJECTED: peer cert not signed by Sigil root CA
```

**PASS condition:** openssl reports TLS error; `TLS REJECTED` in Ingress log; no bytes forwarded. ✅

---

### Test 4.F — Cross-cluster latency overhead

**Exit criterion:** Conduit cross-cluster p99 latency overhead under 5ms vs baseline NodePort.

```bash
# WSL2
CLUSTER2_NODE_IP=$(docker inspect meshlite-dev-2-worker \
  --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')

CONDUIT_EGRESS_IP=$(kubectl --context kind-meshlite-dev \
  get svc -n meshlite-system conduit-egress \
  -o jsonpath='{.spec.clusterIP}')

# Baseline: direct NodePort access to Cluster 2 (no Conduit, plain HTTP)
# First expose service-beta in Cluster 2 as NodePort 30080
kubectl --context kind-meshlite-dev-2 expose deployment service-beta \
  -n meshlite-test --type=NodePort --port=8080 --name=service-beta-np \
  --overrides='{"spec":{"ports":[{"port":8080,"nodePort":30080}]}}' \
  --dry-run=client -o yaml | kubectl --context kind-meshlite-dev-2 apply -f -

kubectl --context kind-meshlite-dev \
  exec -n meshlite-test deploy/service-alpha -- \
  sh -c "for i in \$(seq 1 100); do wget -qO/dev/null http://${CLUSTER2_NODE_IP}:30080/; done; echo done"

# Full Conduit path
kubectl --context kind-meshlite-dev \
  exec -n meshlite-test deploy/service-alpha -- \
  sh -c "for i in \$(seq 1 100); do wget -qO/dev/null --header='Host: service-beta' http://${CONDUIT_EGRESS_IP}:9090/; done; echo done"
```

> `hey` may not be available in the test pod image. Use timing via `date` and loop count if needed.

For p99 calculation, run 500 requests and log timestamps per request with a small script. See Troubleshooting T-3 if `hey` is not available.

**PASS condition:** Conduit path p99 overhead < 5ms. ✅  
**Acceptable fail:** If latency is 5–10ms, document the value and accept it — kind clusters on a single machine have non-representative network latency. The test verifies the overhead is bounded.

---

### Test 4.G — Conduit Ingress restart does not affect in-flight connections

**Exit criterion:** Deleting the Ingress pod during active requests causes Egress to reconnect and resume within 30 seconds.

```bash
# WSL2
# Start a background stream of requests (simulate in-flight)
CONDUIT_EGRESS_IP=$(kubectl --context kind-meshlite-dev \
  get svc -n meshlite-system conduit-egress \
  -o jsonpath='{.spec.clusterIP}')

kubectl --context kind-meshlite-dev exec -n meshlite-test deploy/service-alpha -- \
  sh -c "i=0; while true; do wget -qO/dev/null --header='Host: service-beta' http://${CONDUIT_EGRESS_IP}:9090/; i=\$((i+1)); echo req \$i; sleep 0.5; done" &
BGPID=$!

sleep 3  # Let a few requests flow

# Kill Conduit Ingress pod
kubectl --context kind-meshlite-dev-2 \
  delete pod -n meshlite-system -l app=conduit

# Wait for DaemonSet/Deployment to restart it
kubectl --context kind-meshlite-dev-2 \
  wait pod -n meshlite-system -l app=conduit \
  --for=condition=Ready --timeout=60s

# Give Egress time to reconnect
sleep 10

# Check Egress log for reconnect
kubectl --context kind-meshlite-dev \
  logs -n meshlite-system deploy/conduit-egress | grep -E "reconnect|error|ALLOW" | tail -10

kill $BGPID 2>/dev/null || true
```

Expected: Egress log shows a brief connection error followed by reconnect and resumed `verdict=ALLOW` entries within 30 seconds of the pod deletion.

**PASS condition:** `verdict=ALLOW` entries resume in Egress log within 30s of pod deletion. ✅

---

### Test 4.H — Same-cluster enforcement unaffected by Conduit

**Exit criterion:** Phase 3 tests 3.B and 3.C still pass with Conduit running.

```bash
# WSL2 — Test 3.B: alpha → beta should succeed
kubectl --context kind-meshlite-dev \
  exec -n meshlite-test deploy/service-alpha -- \
  wget -qO- http://service-beta:8080
echo "3.B exit: $?"
```

Expected: `service-beta OK`, exit 0

```bash
# Test 3.C: beta → alpha should fail
kubectl --context kind-meshlite-dev \
  exec -n meshlite-test deploy/service-beta -- \
  wget -qO- --timeout=5 http://service-alpha:8080 \
  && echo "UNEXPECTED_SUCCESS" || echo "3.C exit: $?"
```

Expected: timeout, exit 1

**PASS condition:** 3.B exit 0 with correct output; 3.C exit 1 (timeout). ✅

---

## 6. Exit Criteria Checklist

- [ ] **4.A** — Cross-cluster TCP reachable (no "no route to host") → [Test 4.A](#test-4a--two-clusters-can-reach-each-other-over-docker-bridge)
- [ ] **4.B** — Both Conduit instances log intermediate CA cert receipt → [Test 4.B](#test-4b--conduit-egress-and-ingress-receive-cluster-boundary-certs)
- [ ] **4.C** — Cross-cluster request returns `service-beta OK`, exit 0 → [Test 4.C](#test-4c--cross-cluster-request-succeeds-end-to-end)
- [ ] **4.D** — Unauthorized cross-cluster call denied; Ingress receives no connection → [Test 4.D](#test-4d--cross-cluster-policy-deny)
- [ ] **4.E** — Forged cluster cert causes TLS REJECTED; no bytes forwarded → [Test 4.E](#test-4e--forged-cluster-cert-is-rejected)
- [ ] **4.F** — p99 overhead < 5ms (or documented and accepted if 5–10ms in kind) → [Test 4.F](#test-4f--cross-cluster-latency-overhead)
- [ ] **4.G** — Conduit Ingress restart: enforcement resumes within 30s → [Test 4.G](#test-4g--conduit-ingress-restart-does-not-affect-in-flight-connections)
- [ ] **4.H** — Phase 3 tests 3.B and 3.C still pass with Conduit deployed → [Test 4.H](#test-4h--same-cluster-enforcement-unaffected-by-conduit)

---

## 7. Teardown

```bash
# WSL2 — remove Phase 4 additions from Cluster 1
helm --kube-context kind-meshlite-dev uninstall conduit-egress -n meshlite-system

# Delete Cluster 2 entirely
kind delete cluster --name meshlite-dev-2

# Remove temp CA files
rm -f /tmp/shared-root.crt /tmp/shared-root.key /tmp/fake-cluster.crt /tmp/fake-cluster.key

# Revert Cluster 1 mesh config to one-way (Phase 3 state)
kubectl --context kind-meshlite-dev \
  create configmap sigil-mesh-config \
  -n meshlite-system \
  --from-file=mesh.yaml=tests/fixtures/mesh-one-way.yaml \
  --dry-run=client -o yaml | \
  kubectl --context kind-meshlite-dev apply -f -

# Verify Phase 3 state restored
kubectl --context kind-meshlite-dev \
  exec -n meshlite-test deploy/service-alpha -- wget -qO- http://service-beta:8080
```

Expected after teardown: `service-beta OK` (Phase 3 same-cluster enforcement intact).

---

## 8. Troubleshooting

### T-1 — "no route to host" between clusters

**Symptom:** `wget: unable to connect to remote host (172.19.x.x): No route to host`  
**Root cause:** kind cluster-2 Docker network is not bridged to the same Docker network as cluster-1. By default, kind creates a single `kind` Docker network. If cluster-2 was created with a different Docker network, pods in cluster-1 cannot reach cluster-2 nodes.  
**Resolution:**

```bash
# WSL2
# Verify both clusters are on the same Docker network:
docker network inspect kind | grep -A5 '"Containers"'
# Both meshlite-dev-* and meshlite-dev-2-* containers must appear under the same "kind" network.

# If cluster-2 is on a different network, delete and recreate it:
kind delete cluster --name meshlite-dev-2
kind create cluster --config hack/kind-config-cluster-2.yaml --wait 120s
# kind always uses the "kind" Docker network — this should fix it.
```

---

### T-2 — Cluster 2 Sigil generates a NEW root CA instead of loading the shared one

**Symptom:** Log line: `Sigil CA initialized — generated new root CA` on Cluster 2  
**Root cause:** The `sigil-root-ca` Secret is not being mounted correctly in the Sigil pod. The `--root-key` and `--root-cert` flags are pointing to a path that doesn't match the Secret volume mount.  
**Resolution:** Verify the Helm chart `deployment.yaml` for Sigil. The volume must mount `root.crt` and `root.key` from the Secret at exactly `/data/root.crt` and `/data/root.key`. Check:

```bash
kubectl --context kind-meshlite-dev-2 \
  describe pod -n meshlite-system -l app=sigil | grep -A10 "Mounts:"
```

The PVC mount and the Secret mount must not conflict. If the PVC is mounted at `/data/`, the Secret keys must be projected into the same path or the Sigil flags must be updated.

---

### T-3 — `hey` not available in test pod for latency test

**Symptom:** `hey: not found` inside the pod  
**Root cause:** The test services container image (busybox httpd) does not include `hey`  
**Resolution:** Use `time` + `wget` loop for approximate latency:

```bash
# WSL2
kubectl --context kind-meshlite-dev exec -n meshlite-test deploy/service-alpha -- \
  sh -c 'START=$(date +%s%N); for i in $(seq 1 100); do wget -qO/dev/null --header="Host: service-beta" http://CONDUIT_IP:9090/; done; END=$(date +%s%N); echo "100 reqs in $(( (END-START)/1000000 ))ms"'
```

Divide total ms by 100 for average. p99 cannot be measured this way — note in the report that p99 was not measured due to tooling gap.

---

### T-4 — Conduit Egress fails `EnrollCluster` RPC — "unimplemented"

**Symptom:** `[conduit-egress] ERROR: EnrollCluster RPC: status code: Unimplemented`  
**Root cause:** The `EnrollCluster` RPC was added to the proto but the Sigil server handler was not registered on the gRPC server, or the generated Go code is stale.  
**Resolution:**

```bash
# WSL2
# Verify Sigil has the method registered:
kubectl --context kind-meshlite-dev \
  logs -n meshlite-system deploy/sigil | grep -i "enroll\|cluster"

# If nothing appears, rebuild and redeploy Sigil:
docker build -t meshlite/sigil:phase4 -f sigil/Dockerfile sigil/
kind load docker-image meshlite/sigil:phase4 --name meshlite-dev
kind load docker-image meshlite/sigil:phase4 --name meshlite-dev-2

kubectl --context kind-meshlite-dev set image deployment/sigil \
  sigil=meshlite/sigil:phase4 -n meshlite-system

kubectl --context kind-meshlite-dev-2 set image deployment/sigil \
  sigil=meshlite/sigil:phase4 -n meshlite-system
```

---

### T-5 — TLS handshake fails between Egress and Ingress (chain verify error)

**Symptom:** `[conduit-egress] TLS handshake with cluster-2 failed: certificate verify failed`  
**Root cause:** Most likely one of:  
  (a) Cluster 2 Sigil issued the Ingress cert from a **different** root CA (T-2 root cause)  
  (b) The `root_ca_pem` in the Egress ClusterBundle does not match the root CA that signed the Ingress intermediate cert  
**Resolution:**  
First verify T-2 fix is in place (shared root CA on both clusters). Then:

```bash
# WSL2 — compare root CA fingerprints from both clusters
kubectl --context kind-meshlite-dev \
  exec -n meshlite-system deploy/conduit-egress -- \
  sh -c 'cat /tmp/root_ca.pem | openssl x509 -noout -fingerprint -sha256'

kubectl --context kind-meshlite-dev-2 \
  exec -n meshlite-system deploy/conduit-ingress -- \
  sh -c 'cat /tmp/root_ca.pem | openssl x509 -noout -fingerprint -sha256'
```

Both fingerprints must be identical. If different, Cluster 2 has a different root CA — redo Step 6.

---

### T-6 — `IssueIntermediate` panics or returns nil key

**Symptom:** Sigil crashes on first `EnrollCluster` call; or ClusterBundle has empty `intermediate_key_pem`  
**Root cause:** `IssueIntermediate` in `ca.go` generates a key pair but forgets to marshal/encode the private key to PEM before returning. Compare with the `Issue()` method — it always calls `x509.MarshalPKCS8PrivateKey` + PEM encode.  
**Resolution:** Verify the key encoding path in `IssueIntermediate`:

```go
keyBytes, err := x509.MarshalPKCS8PrivateKey(intermKey)
if err != nil {
    return nil, fmt.Errorf("ca: marshal intermediate key: %w", err)
}
keyPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyBytes})
```

---

### T-7 — `crates/meshlite-tls` build fails due to proto path

**Symptom:** `cargo build` on `meshlite-tls` fails: `error: could not find proto file at ../sigil/proto/sigil.proto`  
**Root cause:** `build.rs` in `meshlite-tls` resolves the proto path relative to the crate directory (`crates/meshlite-tls/`). The proto file is at `sigil/proto/sigil.proto` from repo root — that's `../../sigil/proto/sigil.proto` from the crate.  
**Resolution:** Update `crates/meshlite-tls/build.rs`:

```rust
fn main() {
    tonic_build::compile_protos("../../sigil/proto/sigil.proto")
        .unwrap();
}
```

Verify the path resolves correctly:
```bash
ls -la crates/meshlite-tls/../../sigil/proto/sigil.proto
# Should print: sigil/proto/sigil.proto
```
