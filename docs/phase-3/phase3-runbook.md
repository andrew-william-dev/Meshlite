# MeshLite — Phase 3 Runbook
## Kprobe eBPF Agent: Sigil Integration and Policy Enforcement

> **Status:** Ready for execution
> **Approach:** `docs/phase-3/phase3-approach.md`
> **Last updated:** April 8, 2026

---

## Prerequisites

### Host machine requirements

| Requirement | Version | Check |
|---|---|---|
| WSL2 (Ubuntu 24.04) | any | `wsl --list --running` |
| Rust nightly toolchain | nightly-2024+ | `rustup show` |
| `bpf-linker` | latest | `which bpf-linker` |
| `cargo` | bundled with Rust | `cargo --version` |
| `protoc` | 25+ | `protoc --version` |
| Go | 1.25+ | `go version` |
| Docker (via Docker Desktop + WSL2) | 24+ | `docker version` |
| kind | 0.22+ | `kind version` |
| kubectl | 1.29+ | `kubectl version --client` |
| Helm | 3.14+ | `helm version` |

### What must already be working (from Phase 1 and 2)

```bash
# WSL2 terminal — verify cluster is up
kubectl get nodes
# Expected: 3 nodes in Ready state (meshlite-dev-control-plane + 2 workers)

kubectl get pods -n meshlite-test
# Expected: service-alpha and service-beta in Running state

kubectl get pods -n meshlite-system
# Expected: sigil pod in Running state

# Verify Sigil health
kubectl port-forward -n meshlite-system svc/sigil 8080:8080 &
curl -s http://localhost:8080/healthz
# Expected: {"status":"ok"}
kill %1
```

If the cluster is not running:
```bash
# WSL2 terminal
cd ~/path/to/meshlite
bash hack/dev-cluster.sh
kubectl apply -f tests/fixtures/test-services.yaml

# Re-deploy Sigil if torn down (see Phase 2 runbook for ConfigMap creation and image build)
```

---

## 1. One-Time Machine Setup

### 1.1 Verify protoc is installed

```bash
# WSL2 terminal
protoc --version
# Expected: libprotoc 25.x or later
# If missing:
sudo apt-get install -y protobuf-compiler
```

### 1.2 Verify bpf-linker is installed

```bash
# WSL2 terminal
which bpf-linker
# If missing (required for eBPF compilation):
cargo install bpf-linker
```

### 1.3 Verify rust-src component is installed (required for eBPF build-std)

```bash
# WSL2 terminal — run from kprobe/
rustup component list | grep rust-src
# Expected: rust-src (installed)
# If missing:
rustup component add rust-src
```

### 1.4 Verify linux-headers are installed (required on kind worker nodes for eBPF)

```bash
# WSL2 terminal — check kind worker nodes have the eBPF-capable kernel
kubectl get nodes -o wide
# Expected: VERSION matches the WSL2 kernel version

# The kind nodes inherit the WSL2 kernel — no separate header install needed.
# Verify by checking Phase 1 confirmed TC hooks worked on this cluster.
```

---

## 2. Steps

### Step 2.1 — Task 3.1: eBPF program — add VERDICT_MAP and POLICY_FLAGS

**File:** `kprobe/kprobe-ebpf/src/main.rs`

Add to the eBPF program:
- `PacketKey { src_ip: u32, dst_ip: u32 }` — map key for verdict lookups
- `VERDICT_MAP: HashMap<PacketKey, u8>` — 0 = ALLOW, 1 = DENY
- `POLICY_FLAGS: Array<u32>` — index 0 = `default_allow` (0 = deny-unmatched, 1 = allow-unmatched)
- Update `try_intercept`: look up `(src_ip, dst_ip)` in `VERDICT_MAP`; fall back to `POLICY_FLAGS[0]`

Only consult maps when `src_ip` is in the pod CIDR range (`10.244.0.0/16` in the kind cluster). Node traffic (`172.18.0.0/16`) bypasses the map and always returns `TC_ACT_OK`.

Compile to verify:
```bash
# WSL2 terminal — run from kprobe/
cargo build --package kprobe-ebpf \
  -Z build-std=core \
  --target bpfel-unknown-none \
  --release
# Expected: Compiling kprobe-ebpf ... Finished release [optimized] target(s)
```

Commit: `phase-3: task 3.1 — eBPF VERDICT_MAP and POLICY_FLAGS`

---

### Step 2.2 — Task 3.2: Userspace dependencies and build.rs

**File:** `kprobe/kprobe-userspace/Cargo.toml` — add:
```toml
tonic          = { version = "0.12", features = ["tls", "tls-roots"] }
prost          = "0.13"
kube           = { version = "0.95", features = ["runtime", "derive"] }
k8s-openapi    = { version = "0.23", features = ["v1_30"] }
rustls         = "0.23"
rustls-pemfile = "2"
tokio-stream   = "0.1"
```

Also add `[build-dependencies]`:
```toml
tonic-build = "0.12"
```

**File:** `kprobe/build.rs` — create at workspace root (`kprobe/build.rs`):
```rust
fn main() {
    tonic_build::configure()
        .build_server(false)
        .compile_protos(&["../sigil/proto/sigil.proto"], &["../sigil/proto"])
        .expect("failed to compile sigil.proto");
}
```

Verify proto compilation:
```bash
# WSL2 terminal — run from kprobe/
cargo build --package kprobe-userspace 2>&1 | head -20
# Expected: the build script runs tonic-build without error; generated code appears in target/
```

Commit: `phase-3: task 3.2 — tonic deps and build.rs for sigil.proto`

---

### Step 2.3 — Task 3.3: CertStore

**File:** `kprobe/kprobe-userspace/src/cert_store.rs`

In-memory store keyed by `service_id`. Stores the most recent `CertBundle` per
service. Exposes:
- `update(bundle: CertBundle)` — insert or replace
- `root_ca_pem() -> Option<Vec<u8>>` — returns root CA PEM from any stored bundle (all share the same root)
- `leaf_pem(service_id: &str) -> Option<Vec<u8>>` — returns the leaf cert PEM
- `leaf_key_pem(service_id: &str) -> Option<Vec<u8>>` — returns the private key PEM

**Note:** `CertBundle` from the Sigil proto only carries `service_cert_pem` and `root_ca_pem` — it does NOT carry the private key. The private key is generated client-side (kprobe) and the CSR is sent to Sigil. **Correction to the approach design:** Phase 3 will use the simpler model where the private key is generated entirely by Sigil and the full PEM is pushed. The proto `service_cert_pem` field carries the leaf cert; for mTLS, kprobe generates its own key locally and the `service_cert_pem` is used only for presenting its identity. **Action:** kprobe generates an ECDSA P-256 key on startup; CertStore stores the leaf cert and the local private key together.

Update the Runbook: CertStore contains:
```rust
struct StoredCert {
    leaf_cert_pem: Vec<u8>,  // from CertBundle.service_cert_pem
    root_ca_pem:   Vec<u8>,  // from CertBundle.root_ca_pem
    private_key_pem: Vec<u8>, // generated locally on startup
}
```

Unit test: `cert_store_test` — insert bundle, read back root CA + leaf cert.

Commit: `phase-3: task 3.3 — CertStore`

---

### Step 2.4 — Task 3.4: PolicyCache

**File:** `kprobe/kprobe-userspace/src/policy_cache.rs`

Holds the current `PolicyBundle`. Exposes:
- `update(bundle: PolicyBundle)`
- `default_allow() -> bool`
- `is_allowed(from_svc: &str, to_svc: &str) -> bool` — checks allow rules; returns `default_allow` if no rule matches

Unit tests:
- `allow_rule_matches` — explicit allow pair returns true
- `deny_by_default` — unmatched pair with `default_allow=false` returns false
- `allow_by_default` — unmatched pair with `default_allow=true` returns true

Commit: `phase-3: task 3.4 — PolicyCache`

---

### Step 2.5 — Task 3.5: PodWatcher

**File:** `kprobe/kprobe-userspace/src/pod_watcher.rs`

Uses the `kube` crate to watch Pods on the local node. Exposes:
- `PodWatcher::new(node_name: String) -> Self`
- `run(tx: Sender<PodEvent>)` — async task; sends `PodEvent::Added { service_id, ip }` and `PodEvent::Removed { service_id, ip }` on pod changes
- `snapshot() -> HashMap<String, Vec<Ipv4Addr>>` — current `service_id → IPs` map (service_id = pod's `app` label value)

The kube watcher uses `ListParams::default().fields("spec.nodeName=<node_name>")`.

Unit test: mock pod list returns two pods; snapshot has correct service_id → IP entries.

Commit: `phase-3: task 3.5 — PodWatcher`

---

### Step 2.6 — Task 3.6: VerdictSync

**File:** `kprobe/kprobe-userspace/src/verdict_sync.rs`

Translates the current `PolicyCache` + `PodWatcher` snapshot into `VERDICT_MAP` writes. Exposes:
- `VerdictSync::new(verdict_map: Arc<Mutex<AyaHashMap<...>>>, policy_flags: Arc<Mutex<AyaArray<...>>>)`
- `sync(policy: &PolicyCache, pods: &HashMap<String, Vec<Ipv4Addr>>)`

Algorithm:
1. Clear `VERDICT_MAP`.
2. For every `(from_svc, to_svc)` pair where `from_svc` and `to_svc` both have pod IPs:
   - If `policy.is_allowed(from_svc, to_svc)` → for each `(src_ip, dst_ip)` pair: insert `VERDICT_MAP[PacketKey{src, dst}] = 0`.
   - Else → insert `= 1`.
3. Write `POLICY_FLAGS[0] = policy.default_allow() as u32`.
4. Log `[VERDICT_SYNC] wrote N entries, default_allow=<bool>`.

Unit test: two services, one allow rule → correct VERDICT_MAP entries.

**Note on Aya HashMap types in userspace:** Use `aya::maps::HashMap` with the map taken from the loaded `Ebpf` object. The `PacketKey` struct must be `#[repr(C)]` and match the eBPF-side definition exactly.

Commit: `phase-3: task 3.6 — VerdictSync`

---

### Step 2.7 — Task 3.7: SigilClient with mTLS state machine

**File:** `kprobe/kprobe-userspace/src/sigil_client.rs`

Implements the three-state mTLS reconnect machine:

```
State::Bootstrap
  → tonic channel with InsecureSkipVerify TLS (accepts any server cert)
  → sends AgentHello { node_id, cluster_id, pod_service_ids }
  → on first CertBundle received: store in CertStore; transition to State::UpgradingTLS

State::UpgradingTLS
  → close bootstrap channel
  → build tonic TLS channel:
      root CA  = CertStore.root_ca_pem()
      client cert+key = local ECDSA key + leaf cert from CertStore
  → reconnect; re-send AgentHello
  → log: [SIGIL] mTLS reconnect node=<node_id>
  → transition to State::ConnectedTLS

State::ConnectedTLS
  → all subsequent AgentPush messages arrive here
  → on CertBundle: CertStore.update(); trigger VerdictSync
  → on PolicyBundle: PolicyCache.update(); trigger VerdictSync
  → on connection drop: transition back to State::UpgradingTLS
```

The `SigilClient` exposes:
- `SigilClient::new(sigil_addr: String, node_id: String, cluster_id: String, pod_service_ids: Vec<String>)`
- `run(cert_store: Arc<Mutex<CertStore>>, policy_cache: Arc<Mutex<PolicyCache>>, sync_tx: Sender<()>)` — async loop; sends to `sync_tx` to trigger VerdictSync on every push

Unit test: mock gRPC server pushes one CertBundle; verifies state transitions and CertStore update.

Commit: `phase-3: task 3.7 — SigilClient mTLS state machine`

---

### Step 2.8 — Task 3.8: main.rs rewrite

**File:** `kprobe/kprobe-userspace/src/main.rs`

New CLI flags:
```
--iface     <str>   network interface (default: eth0)
--ebpf-path <str>   compiled eBPF object path (default: /app/kprobe-ebpf)
--sigil-addr <str>  Sigil gRPC address (default: sigil.meshlite-system.svc.cluster.local:8443)
--node-id   <str>   Kubernetes node name (default: $NODE_NAME env var)
--cluster-id <str>  Cluster ID (default: dev)
```

Startup sequence:
1. Load eBPF object and attach TC egress hook (same as Phase 1).
2. Open `VERDICT_MAP` and `POLICY_FLAGS` from loaded eBPF object.
3. Spawn `PodWatcher::run()` task.
4. Spawn `SigilClient::run()` task.
5. Spawn `VerdictSync` task — triggered by channel from SigilClient; reads PolicyCache + PodWatcher snapshot.
6. Spawn perf event reader tasks (same as Phase 1, now also logs ALLOW/DENY per-packet).
7. Block on Ctrl+C / SIGTERM.

Log format additions (perf event reader):
```
[INTERCEPT] src=10.244.1.5:43210 dst=10.244.2.7:8080 proto=TCP verdict=ALLOW
[INTERCEPT] src=10.244.2.7:55123 dst=10.244.1.5:8080 proto=TCP verdict=DENY
```

Commit: `phase-3: task 3.8 — main.rs orchestration`

---

### Step 2.9 — Task 3.9: Sigil CA — IssueWithDNS

**File:** `sigil/internal/ca/ca.go`

Add a new method alongside the existing `Issue()`:
```go
func (c *CA) IssueWithDNS(serviceID, clusterID, namespace string, dnsNames []string) (*IssuedCert, error)
```

Same as `Issue()` but also adds `dnsNames` as `x509.Certificate.DNSNames`.

Unit test: issued cert has expected DNS SANs.

**File:** `sigil/cmd/server/main.go`

Before starting the gRPC listener, issue a server cert for Sigil:
```go
serverCert, err := authority.IssueWithDNS("sigil", eng.ClusterID(), "meshlite-system", []string{
    "sigil.meshlite-system.svc.cluster.local",
    "sigil.meshlite-system.svc",
    "sigil.meshlite-system",
    "sigil",
    "localhost",
})
```

Build `tls.Config` with `ClientAuth: tls.RequestClientCert` (so plaintext bootstrap is rejected, but TLS-without-client-cert is allowed). Start the gRPC server with `grpc.Creds(credentials.NewTLS(tlsCfg))`.

**File:** `sigil/internal/distributor/distributor.go`

Add `WithServerOptions(opts ...grpc.ServerOption)` to `New()` or accept them in `Serve()`. Propagate the TLS credentials to `grpc.NewServer(opts...)`.

Commit: `phase-3: task 3.9 — Sigil CA IssueWithDNS + gRPC TLS`

---

### Step 2.10 — Task 3.10: Kprobe Dockerfile

**File:** `kprobe/Dockerfile` — two-stage build:

```dockerfile
# Stage 1 — compile eBPF object (bpfel-unknown-none target)
FROM rustlang/rust:nightly AS ebpf-builder
RUN cargo install bpf-linker
WORKDIR /build
COPY kprobe/ kprobe/
COPY sigil/proto/ sigil/proto/
RUN cd kprobe && \
    cargo build --package kprobe-ebpf \
        -Z build-std=core \
        --target bpfel-unknown-none \
        --release

# Stage 2 — compile userspace binary (x86_64-unknown-linux-musl for static binary)
FROM rustlang/rust:nightly AS userspace-builder
RUN rustup component add rust-src
RUN apt-get update && apt-get install -y protobuf-compiler musl-tools && rm -rf /var/lib/apt/lists/*
RUN rustup target add x86_64-unknown-linux-musl
WORKDIR /build
COPY kprobe/ kprobe/
COPY sigil/proto/ sigil/proto/
COPY --from=ebpf-builder \
     /build/kprobe/target/bpfel-unknown-none/release/kprobe-ebpf \
     /build/kprobe/target/bpfel-unknown-none/release/kprobe-ebpf
RUN cd kprobe && \
    cargo build --package kprobe-userspace \
        --release \
        --target x86_64-unknown-linux-musl

# Stage 3 — minimal runtime image
FROM scratch
COPY --from=ebpf-builder \
     /build/kprobe/target/bpfel-unknown-none/release/kprobe-ebpf \
     /app/kprobe-ebpf
COPY --from=userspace-builder \
     /build/kprobe/target/x86_64-unknown-linux-musl/release/kprobe-loader \
     /app/kprobe-loader
ENTRYPOINT ["/app/kprobe-loader"]
```

Build and load into kind:
```bash
# WSL2 terminal — run from workspace root
docker build -t meshlite/kprobe:phase3 -f kprobe/Dockerfile .
# Expected: Successfully built ...

kind load docker-image meshlite/kprobe:phase3 --name meshlite-dev
# Expected: Image: "meshlite/kprobe:phase3" with ID "sha256:..." not yet present on node ...
# Loaded
```

Commit: `phase-3: task 3.10 — Kprobe Dockerfile`

---

### Step 2.11 — Task 3.11: Kprobe Helm chart

**Directory:** `charts/kprobe/`

Files to create:

**`charts/kprobe/Chart.yaml`:**
```yaml
apiVersion: v2
name: kprobe
description: Kprobe — MeshLite eBPF Enforcer DaemonSet
type: application
version: 0.1.0
appVersion: "phase3"
```

**`charts/kprobe/values.yaml`:**
```yaml
image:
  repository: meshlite/kprobe
  pullPolicy: IfNotPresent
  tag: "phase3"

sigil:
  addr: "sigil.meshlite-system.svc.cluster.local:8443"

cluster:
  id: "dev"

ebpf:
  iface: "eth0"
  path: "/app/kprobe-ebpf"
```

**`charts/kprobe/templates/daemonset.yaml`:** DaemonSet in `meshlite-system` with:
- `securityContext.privileged: true`
- capabilities: `SYS_ADMIN`, `NET_ADMIN`, `SYS_RESOURCE`
- `hostNetwork: false` (uses pod network to generate its own traffic — it intercepts node's eth0)
- env `NODE_NAME` from `spec.nodeName` (fieldRef)
- `.spec.template.spec.hostPID: false`
- `tolerations`: `operator: Exists` (run on control-plane node too)
- `nodeSelector`: none (all nodes in meshlite-dev)
- args: `--iface $(IFACE) --ebpf-path $(EBPF_PATH) --sigil-addr $(SIGIL_ADDR) --node-id $(NODE_NAME) --cluster-id $(CLUSTER_ID)`

**`charts/kprobe/templates/rbac.yaml`:** ServiceAccount + ClusterRole + ClusterRoleBinding  
ClusterRole rules:
- `apiGroups: [""]`, `resources: ["pods"]`, `verbs: ["get", "list", "watch"]`
- `apiGroups: [""]`, `resources: ["nodes"]`, `verbs: ["get"]`

**`charts/kprobe/templates/_helpers.tpl`:** standard fullname helper.

Commit: `phase-3: task 3.11 — Kprobe Helm chart`

---

### Step 2.12 — Task 3.12: Sigil image rebuild and Helm upgrade

Rebuild the Sigil image with the TLS changes from Task 3.9:
```bash
# WSL2 terminal — run from workspace root
docker build -t meshlite/sigil:phase3 sigil/
# Expected: Successfully built ...

kind load docker-image meshlite/sigil:phase3 --name meshlite-dev
```

Update `charts/sigil/values.yaml`: change `tag: "phase2"` → `tag: "phase3"`.

Upgrade the running Sigil deployment:
```bash
# WSL2 terminal
helm upgrade sigil charts/sigil/ \
  --namespace meshlite-system \
  --reuse-values \
  --set image.tag=phase3
# Expected: Release "sigil" has been upgraded. Happy Helming!

kubectl rollout status deployment/sigil -n meshlite-system
# Expected: deployment "sigil" successfully rolled out

# Verify TLS is now active on the gRPC port
kubectl port-forward -n meshlite-system svc/sigil 8443:8443 &
openssl s_client -connect localhost:8443 -showcerts 2>/dev/null | \
  openssl x509 -noout -subject -issuer
# Expected: subject includes "sigil" and issuer is the MeshLite root CA
kill %1
```

Commit: `phase-3: task 3.12 — Sigil rebuilt with TLS, image tag phase3`

---

### Step 2.13 — Deploy the meshlite-system namespace PSA label (if needed)

```bash
# WSL2 terminal
kubectl get namespace meshlite-system -o jsonpath='{.metadata.labels}' | python3 -m json.tool
# Look for pod-security.kubernetes.io/enforce label
# If "restricted" or "baseline" is set, privileged DaemonSet will be blocked.
# If label is absent (kind default), skip to Step 2.14.

# If needed — label namespace to allow privileged pods:
kubectl label namespace meshlite-system \
  pod-security.kubernetes.io/enforce=privileged \
  pod-security.kubernetes.io/warn=privileged \
  pod-security.kubernetes.io/audit=privileged
```

---

### Step 2.14 — Deploy the Kprobe DaemonSet

```bash
# WSL2 terminal
helm install kprobe charts/kprobe/ \
  --namespace meshlite-system \
  --create-namespace
# Expected: Release "kprobe" deployed. Happy Helming!

kubectl rollout status daemonset/kprobe -n meshlite-system
# Expected: daemon set "kprobe" successfully rolled out

kubectl get pods -n meshlite-system -l app=kprobe -o wide
# Expected: one kprobe pod per node (3 total: control-plane + 2 workers)
# STATUS: Running

# Tail logs from the worker node pod (where test services run)
WORKER_POD=$(kubectl get pods -n meshlite-system -l app=kprobe \
  --field-selector spec.nodeName=meshlite-dev-worker \
  -o jsonpath='{.items[0].metadata.name}')
kubectl logs "$WORKER_POD" -n meshlite-system --follow &
```

---

### Step 2.15 — Apply mesh-one-way.yaml policy

```bash
# WSL2 terminal
kubectl create configmap sigil-mesh-config \
  --from-file=mesh.yaml=tests/fixtures/mesh-one-way.yaml \
  --namespace meshlite-system \
  --dry-run=client -o yaml | kubectl apply -f -
# Expected: configmap/sigil-mesh-config configured

# Trigger Sigil to reload the policy
kubectl port-forward -n meshlite-system svc/sigil 8080:8080 &
curl -s -X POST http://localhost:8080/api/v1/config \
  -H "Content-Type: application/json" \
  -d @tests/fixtures/mesh-one-way.yaml
# Expected: {"status":"ok"}
kill %1
```

---

## 3. Tests

### Test 3.A — Kprobe agent connects to Sigil and receives CertBundle

**Verifies exit criterion 3.A**

```bash
# WSL2 terminal
WORKER_POD=$(kubectl get pods -n meshlite-system -l app=kprobe \
  --field-selector spec.nodeName=meshlite-dev-worker \
  -o jsonpath='{.items[0].metadata.name}')
kubectl logs "$WORKER_POD" -n meshlite-system | grep -E '\[SIGIL\] connected|CertBundle'
```

**Expected output (within 10 seconds of pod start):**
```
[SIGIL] connected node=meshlite-dev-worker cluster=dev
[SIGIL] CertBundle received service=service-alpha
[SIGIL] CertBundle received service=service-beta
```

**Pass condition:** Both `[SIGIL] connected` and at least one `CertBundle received` line appear in the pod log within 10 seconds of the pod reaching `Running` state.

**Fail condition:** If `[SIGIL] connected` does not appear, check the Sigil pod logs for TLS errors. If CertBundle is not received, verify `pod_service_ids` in `AgentHello` includes the correct service IDs.

---

### Test 3.B — Allowed traffic (service-alpha → service-beta) passes through

**Verifies exit criterion 3.B**

```bash
# WSL2 terminal
ALPHA_POD=$(kubectl get pods -n meshlite-test -l app=service-alpha \
  -o jsonpath='{.items[0].metadata.name}')

kubectl exec -n meshlite-test "$ALPHA_POD" -- \
  wget -qO- --timeout=5 http://service-beta:8080
```

**Expected output:** the default busybox httpd HTML response (not an error).

```bash
# Verify the kprobe log shows ALLOW verdict
WORKER_POD=$(kubectl get pods -n meshlite-system -l app=kprobe \
  --field-selector spec.nodeName=meshlite-dev-worker \
  -o jsonpath='{.items[0].metadata.name}')
kubectl logs "$WORKER_POD" -n meshlite-system | grep 'verdict=ALLOW'
# Expected: at least one line with dst=<beta-ip>:8080 verdict=ALLOW
```

**Pass condition:** `wget` returns HTTP content (exit 0) AND at least one `verdict=ALLOW` log line exists for traffic toward `service-beta:8080`.

**Fail condition:** `wget` hangs or exits with error. Check that the VERDICT_MAP was populated: add a debug flag or log from VerdictSync showing the number of entries written.

---

### Test 3.C — Denied traffic (service-beta → service-alpha) is dropped

**Verifies exit criterion 3.C**

```bash
# WSL2 terminal
BETA_POD=$(kubectl get pods -n meshlite-test -l app=service-beta \
  -o jsonpath='{.items[0].metadata.name}')

kubectl exec -n meshlite-test "$BETA_POD" -- \
  wget -qO- --timeout=5 http://service-alpha:8080
echo "Exit code: $?"
```

**Expected output:** no response; `wget` times out after 5 seconds and exits non-zero.

```bash
# Verify kprobe shows DENY verdict
kubectl logs "$WORKER_POD" -n meshlite-system | grep 'verdict=DENY'
# Expected: at least one line with dst=<alpha-ip>:8080 verdict=DENY
```

**Pass condition:** `wget` does NOT return HTTP content (exit code ≠ 0) AND at least one `verdict=DENY` log line exists for traffic toward `service-alpha:8080`.

**Fail condition:** If `wget` succeeds unexpectedly — check `VERDICT_MAP` was written correctly. If `DENY` entries are absent but policy is correct, verify that pod IPs resolved correctly in PodWatcher and that `VerdictSync.sync()` ran after the PolicyBundle was received.

---

### Test 3.D — Live policy reload updates eBPF VERDICT_MAP

**Verifies exit criterion 3.D**

```bash
# WSL2 terminal — create bidirectional allow policy
cat > /tmp/mesh-bidirectional.yaml << 'EOF'
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
    - from: service-beta
      to: [service-alpha]
EOF

kubectl create configmap sigil-mesh-config \
  --from-file=mesh.yaml=/tmp/mesh-bidirectional.yaml \
  --namespace meshlite-system \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl port-forward -n meshlite-system svc/sigil 8080:8080 &
curl -s -X POST http://localhost:8080/api/v1/config \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/mesh-bidirectional.yaml
kill %1
# Expected: {"status":"ok"}

# Wait up to 5 seconds, then test the previously-denied direction
sleep 3
kubectl exec -n meshlite-test "$BETA_POD" -- \
  wget -qO- --timeout=5 http://service-alpha:8080
echo "Exit code: $?"
```

**Expected output:** HTTP response from service-alpha (exit 0).

```bash
# Verify kprobe received policy update
kubectl logs "$WORKER_POD" -n meshlite-system | grep '\[POLICY\] updated'
# Expected: [POLICY] updated rules=2
```

**Pass condition:** `wget` from beta→alpha returns HTTP content within 5 seconds of the config POST, without any kprobe pod restart. `[POLICY] updated rules=2` appears in the kprobe log.

---

### Test 3.E — mTLS on Kprobe→Sigil channel

**Verifies exit criterion 3.E**

```bash
# WSL2 terminal — check kprobe log for mTLS reconnect
kubectl logs "$WORKER_POD" -n meshlite-system | grep '\[SIGIL\] mTLS reconnect'
# Expected: [SIGIL] mTLS reconnect node=meshlite-dev-worker

# Verify Sigil's gRPC port presents a valid TLS cert
kubectl port-forward -n meshlite-system svc/sigil 8443:8443 &
sleep 1
echo | openssl s_client -connect localhost:8443 2>/dev/null | \
  openssl x509 -noout -subject -issuer -dates
kill %1
```

**Expected TLS cert output:**
```
subject=CN=sigil
issuer=CN=MeshLite Root CA
notBefore=...
notAfter=...
```

**Pass condition:** Both `[SIGIL] mTLS reconnect` appears in kprobe log AND `openssl s_client` connects successfully and shows a cert issued by the MeshLite root CA.

---

### Test 3.F — Enforcement resumes after DaemonSet restart

**Verifies exit criterion 3.F**

First restore one-way policy:
```bash
# WSL2 terminal
kubectl create configmap sigil-mesh-config \
  --from-file=mesh.yaml=tests/fixtures/mesh-one-way.yaml \
  --namespace meshlite-system \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl port-forward -n meshlite-system svc/sigil 8080:8080 &
curl -s -X POST http://localhost:8080/api/v1/config \
  -H "Content-Type: application/json" \
  --data-binary @tests/fixtures/mesh-one-way.yaml
kill %1
```

Restart the DaemonSet:
```bash
kubectl rollout restart daemonset/kprobe -n meshlite-system
kubectl rollout status daemonset/kprobe -n meshlite-system
# Expected: daemon set "kprobe" successfully rolled out
```

Re-run Tests 3.B and 3.C (allow alpha→beta, deny beta→alpha):
```bash
# Test 3.B re-run (must pass within 20 seconds of rollout completing)
kubectl exec -n meshlite-test "$ALPHA_POD" -- \
  wget -qO- --timeout=5 http://service-beta:8080
echo "Exit code: $?"
# Expected: HTTP response, exit 0

# Test 3.C re-run
kubectl exec -n meshlite-test "$BETA_POD" -- \
  wget -qO- --timeout=5 http://service-alpha:8080
echo "Exit code: $?"
# Expected: timeout/error, exit non-zero
```

**Pass condition:** Both alpha→beta allow and beta→alpha deny work correctly within 20 seconds of the DaemonSet rollout completing.

---

## 4. Exit Criteria Checklist

- [ ] **3.A** — [Test 3.A](#test-3a--kprobe-agent-connects-to-sigil-and-receives-certbundle): Kprobe connects and receives CertBundle within 10s
- [ ] **3.B** — [Test 3.B](#test-3b--allowed-traffic-service-alpha--service-beta-passes-through): alpha→beta HTTP 200 with `verdict=ALLOW` in log
- [ ] **3.C** — [Test 3.C](#test-3c--denied-traffic-service-beta--service-alpha-is-dropped): beta→alpha timeout with `verdict=DENY` in log
- [ ] **3.D** — [Test 3.D](#test-3d--live-policy-reload-updates-ebpf-verdict_map): live reload allows previously-denied direction within 5s; no pod restart
- [ ] **3.E** — [Test 3.E](#test-3e--mtls-on-kprobesigil-channel): `[SIGIL] mTLS reconnect` in log; openssl confirms TLS cert from root CA
- [ ] **3.F** — [Test 3.F](#test-3f--enforcement-resumes-after-daemonset-restart): enforcement restored within 20s after DaemonSet rollout

---

## 5. Teardown

```bash
# WSL2 terminal — remove kprobe DaemonSet
helm uninstall kprobe --namespace meshlite-system

# Rollback Sigil to phase2 image (removes TLS from gRPC port)
helm upgrade sigil charts/sigil/ \
  --namespace meshlite-system \
  --reuse-values \
  --set image.tag=phase2

# Remove Docker images (optional)
docker rmi meshlite/kprobe:phase3
docker rmi meshlite/sigil:phase3

# To fully destroy the cluster:
# bash hack/teardown.sh
```

---

## 6. Troubleshooting

| Symptom | Root Cause | Resolution |
|---|---|---|
| Kprobe pod stuck in `CrashLoopBackOff` | eBPF program fails to load (verifier error) | `kubectl logs <pod>` — look for `[ERROR] Kernel rejected the eBPF program`. Check VERDICT_MAP key type matches between eBPF and userspace (`#[repr(C)]` struct layout). |
| Kprobe pod stuck in `CrashLoopBackOff` — `Operation not permitted` | Missing `privileged: true` or `SYS_ADMIN` capability | Verify DaemonSet securityContext. Check PSA namespace label. |
| `[SIGIL] connected` never appears | Sigil gRPC unreachable from kprobe pod | `kubectl exec -n meshlite-system <kprobe-pod> -- nslookup sigil.meshlite-system.svc.cluster.local` — verify DNS resolves. Check Sigil pod is Running. |
| `tls: failed to verify certificate` on bootstrap | Bootstrap TLS config is not using `InsecureSkipVerify: true` | Verify `sigil_client.rs` bootstrap state uses the skip-verify TLS config. |
| `[SIGIL] mTLS reconnect` never appears | CertBundle not received on bootstrap | Check `AgentHello.pod_service_ids` is non-empty. Verify Sigil's `OnConnect` callback fires. Check Sigil pod log for `on-connect cert issue failed`. |
| All traffic dropped (alpha→beta fails) | `VERDICT_MAP` never populated / VerdictSync not running | Check kprobe log for `[VERDICT_SYNC] wrote N entries`. If N=0, check PodWatcher found pods on the node and PolicyCache has rules. |
| Policy reload has no effect (Test 3.D fails) | SigilClient stream disconnected; not receiving PolicyBundle push | Check kprobe log for `[POLICY] updated`. Verify `POST /api/v1/config` returned `{"status":"ok"}`. Verify Sigil distributor has the kprobe agent registered. |
| Pod IPs in VERDICT_MAP stale after pod reschedule | PodWatcher not detecting pod IP changes | Verify `ListWatch` informer is sharing the same `sync_tx` channel as VerdictSync. Check pod `app` label matches the `service_id` used in policy rules. |
| `TC_ACT_SHOT` drops kubelet heartbeats — nodes unhealthy | Pod CIDR guard not working in eBPF | Verify eBPF `try_intercept` skips VERDICT_MAP lookup when `src_ip` is not in `10.244.0.0/16`. Check pod CIDR with `kubectl get cm -n kube-system kubeadm-config`. |
| Sigil gRPC port shows self-signed cert not from root CA | `IssueWithDNS` not called before gRPC start | Check Sigil startup log for cert issuance. Verify `--root-cert` path is correct (PVC must be bound). |
| `helm upgrade sigil` rolls pod but it crashes | New image tag not built/loaded into kind | Verify `docker images | grep meshlite/sigil:phase3` and `kind load docker-image meshlite/sigil:phase3 --name meshlite-dev` both completed. |
| `error loading eBPF object: no such file or directory` | eBPF path mismatch in container | Dockerfile copies eBPF to `/app/kprobe-ebpf`. Helm chart passes `--ebpf-path /app/kprobe-ebpf`. Verify both match. |
