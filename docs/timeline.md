# MeshLite — Development Plan & Testing Strategy

> **Purpose:** This is the engineering execution roadmap. It tells you what to build in what order, why that order, and exactly how to verify each piece works before moving to the next. Every phase has a clear exit criteria — you do not move forward until those criteria are met.
>
> **Stack recap:** Sigil (Go) · Kprobe (Rust + Aya) · Conduit (Rust + Tokio) · Trace (Go backend + React frontend) · meshctl (Go + Cobra)
>
> **Total phases:** 5 · **Estimated timeline:** 28–32 weeks part-time (15–20h/week)

---

## Table of Contents

1. [How to Read This Plan](#1-how-to-read-this-plan)
2. [Local Development Environment Setup](#2-local-development-environment-setup)
3. [Phase 1 — Kprobe: eBPF Traffic Interception Proof of Concept](#3-phase-1--kprobe-ebpf-traffic-interception-proof-of-concept)
4. [Phase 2 — Sigil: Certificate Authority and Control Plane](#4-phase-2--sigil-certificate-authority-and-control-plane)
5. [Phase 3 — Kprobe: Full mTLS and Policy Enforcement](#5-phase-3--kprobe-full-mtls-and-policy-enforcement)
6. [Phase 4 — Conduit: Cross-Cluster Gateway](#6-phase-4--conduit-cross-cluster-gateway)
7. [Phase 5 — Trace and meshctl: Observability and CLI](#7-phase-5--trace-and-meshctl-observability-and-cli)
8. [Integration Testing Strategy](#8-integration-testing-strategy)
9. [Milestone Summary](#9-milestone-summary)

---

## 1. How to Read This Plan

Each phase follows this structure:

- **Goal** — the single sentence answer to "what does this phase achieve"
- **Why this comes first** — the dependency reason for this ordering
- **What you build** — specific deliverables, broken into tasks
- **Testing strategy** — exactly how to verify it works locally before proceeding
- **Exit criteria** — the non-negotiable checklist. All boxes must be checked to close the phase

### The ordering principle

The phases are ordered by **dependency**, not by importance. Kprobe comes before Sigil in terms of proof-of-concept, but Sigil is built fully before Kprobe is wired up. The logic is:

```
Phase 1 → Prove eBPF interception works (risk reduction)
Phase 2 → Build Sigil (everything else depends on certs)
Phase 3 → Wire Kprobe to Sigil (same-cluster mTLS complete)
Phase 4 → Build Conduit (cross-cluster on top of same-cluster)
Phase 5 → Build Trace + meshctl (observability on top of enforcement)
```

Never skip a phase. Each one is the foundation for the next.

---

## 2. Local Development Environment Setup

> Before writing a single line of product code, your local environment must be in this state. This is not optional — these tools are load-bearing for every test in every phase.

### 2.1 Required tools

| Tool | Version | Purpose |
|---|---|---|
| Rust | 1.75+ (stable) | Kprobe and Conduit |
| Go | 1.22+ | Sigil, Trace, meshctl |
| Node.js | 20+ | Trace frontend |
| Docker | 24+ | Building container images |
| kind | 0.22+ | Local Kubernetes clusters |
| kubectl | 1.29+ | Cluster interaction |
| Helm | 3.14+ | Chart packaging and install |
| grpcurl | latest | Testing gRPC endpoints manually |
| protoc | 25+ | Protobuf code generation |
| Linux kernel | 5.15+ | eBPF features used by Kprobe |

> **Important on macOS:** eBPF only runs on Linux. Use a Linux VM (UTM, Multipass, or Lima) for all Kprobe development. Sigil, Trace, and meshctl can be developed natively on macOS.

### 2.2 Repository structure

```
meshlite/
├── sigil/              # Go — control plane
│   ├── cmd/
│   ├── internal/
│   │   ├── ca/         # Certificate Authority
│   │   ├── policy/     # Policy engine
│   │   ├── registry/   # Service registry
│   │   └── distributor/# gRPC push to agents
│   └── proto/          # Protobuf definitions (shared)
│
├── kprobe/             # Rust — eBPF enforcer
│   ├── kprobe-ebpf/    # Kernel-side eBPF program (no_std)
│   └── kprobe-userspace/ # Userspace loader + Sigil client
│
├── conduit/            # Rust — cross-cluster gateway
│   └── src/
│
├── trace/              # Go backend + React frontend
│   ├── backend/
│   └── frontend/
│
├── meshctl/            # Go CLI
│   └── cmd/
│
├── charts/             # Helm charts
│   ├── meshlite/       # Umbrella chart
│   ├── sigil/
│   ├── kprobe/
│   ├── conduit/
│   └── trace/
│
├── tests/
│   ├── e2e/            # End-to-end test scenarios
│   └── fixtures/       # Test mesh.yaml files, certs, mock services
│
└── hack/
    ├── dev-cluster.sh  # Spins up kind cluster
    └── teardown.sh
```

### 2.3 Spin up local Kubernetes cluster

```bash
# Create a two-node kind cluster for same-cluster testing
cat > hack/kind-config.yaml << EOF
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
  - role: worker
  - role: worker
EOF

kind create cluster --config hack/kind-config.yaml --name meshlite-dev

# Verify
kubectl get nodes
# Expected: control-plane + 2 workers in Ready state
```

### 2.4 Cross-cluster local setup (needed from Phase 4)

```bash
# Two separate kind clusters for cross-cluster testing
kind create cluster --name cluster-1
kind create cluster --name cluster-2

# Switch between them
kubectl config use-context kind-cluster-1
kubectl config use-context kind-cluster-2
```

---

## 3. Phase 1 — Kprobe: eBPF Traffic Interception Proof of Concept

**Goal:** Prove that an eBPF program loaded via Aya can intercept a real TCP packet between two pods on a Kubernetes node, log it, and return control without disrupting the connection.

**Why this comes first:** eBPF interception is the highest technical risk in the entire project. If this does not work, everything else is moot. Phase 1 kills that risk before a single line of production code is written. You are not building Kprobe here — you are proving it is possible.

**Estimated time:** 3–4 weeks

---

### 3.1 What you build

#### Task 1.1 — eBPF program: intercept and log

Write the minimal eBPF program in Rust using Aya. It should:

- Attach to the `tc` (traffic control) egress hook on a network interface
- Intercept every outgoing packet
- Extract source IP, destination IP, source port, destination port
- Write them to a perf event array (ring buffer to userspace)
- Return `TC_ACT_OK` — do not drop or modify the packet

```rust
// kprobe/kprobe-ebpf/src/main.rs (skeleton)
#![no_std]
#![no_main]

use aya_ebpf::{
    macros::classifier,
    programs::TcContext,
    maps::PerfEventArray,
};

#[classifier]
pub fn kprobe_egress(ctx: TcContext) -> i32 {
    // 1. Parse ethernet + IP + TCP headers
    // 2. Extract src/dst IP and ports
    // 3. Write to perf event array
    // 4. Return TC_ACT_OK
    TC_ACT_OK
}
```

#### Task 1.2 — Userspace loader

Write the userspace Rust program that:

- Loads the eBPF program into the kernel using Aya
- Attaches it to the correct network interface on a node
- Reads from the perf event array
- Prints intercepted packets to stdout

#### Task 1.3 — Deploy two test pods

Create two simple HTTP server pods in the kind cluster. They will be your test subjects throughout all phases.

```yaml
# tests/fixtures/test-services.yaml
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: service-alpha
spec:
  replicas: 1
  template:
    spec:
      containers:
      - name: server
        image: python:3.11-slim
        command: ["python", "-m", "http.server", "8080"]
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: service-beta
spec:
  replicas: 1
  template:
    spec:
      containers:
      - name: server
        image: python:3.11-slim
        command: ["python", "-m", "http.server", "8080"]
```

---

### 3.2 Testing Strategy — Phase 1

#### Test 1.A — Basic interception: does the eBPF hook fire?

```bash
# Terminal 1 — run the userspace loader on the cluster node
# (SSH into the kind worker node or run as privileged DaemonSet)
cargo run --bin kprobe-loader

# Terminal 2 — generate traffic between the two test pods
kubectl exec -it deploy/service-alpha -- curl http://service-beta:8080

# Expected output in Terminal 1:
# [INTERCEPT] src=10.244.1.5:43210 dst=10.244.2.7:8080 proto=TCP
```

**What you are verifying:** The eBPF program fires on egress and successfully passes packet metadata to userspace via the perf event array.

---

#### Test 1.B — Interception does not break connectivity

```bash
# Run 100 requests while the eBPF program is loaded
kubectl exec -it deploy/service-alpha -- \
  sh -c 'for i in $(seq 1 100); do curl -s -o /dev/null -w "%{http_code}" http://service-beta:8080; done'

# Expected: 100 lines of "200"
# Zero failures = the TC_ACT_OK passthrough is working correctly
```

**What you are verifying:** Returning `TC_ACT_OK` correctly passes the packet through without corruption.

---

#### Test 1.C — Only intercept pod-to-pod traffic, not host traffic

```bash
# Generate traffic FROM the node itself (not a pod)
curl http://service-beta:8080

# The userspace loader should NOT log this — it should only see pod traffic
# Verify by checking that the source IP in logs is a pod CIDR address (10.244.x.x)
# not the node's host IP
```

**What you are verifying:** The hook is scoped correctly to pod network interfaces.

---

#### Test 1.D — Performance baseline (critical — measure before adding anything)

```bash
# Install hey (HTTP load testing tool) in service-alpha
kubectl exec -it deploy/service-alpha -- \
  hey -n 10000 -c 50 http://service-beta:8080

# Run once WITHOUT Kprobe loaded → record baseline p50, p95, p99 latency
# Run once WITH Kprobe loaded (TC_ACT_OK passthrough only)
# Run once WITH Kprobe loaded + perf event write

# Acceptable overhead at this stage: < 0.5ms p99 increase
# If overhead is higher, the perf event write path needs optimisation before proceeding
```

**What you are verifying:** The interception layer itself adds acceptable overhead. This is your baseline for every future phase.

---

### 3.3 Exit Criteria — Phase 1

- [ ] eBPF program compiles and loads into the kernel without verifier rejection
- [ ] Every pod-to-pod TCP packet is intercepted and logged in userspace
- [ ] 100 sequential requests between test pods return HTTP 200 with eBPF loaded
- [ ] p99 latency overhead from interception alone is under 0.5ms
- [ ] Kprobe loader runs as a privileged DaemonSet pod without crashing
- [ ] Unloading the eBPF program (pod deleted) leaves cluster network fully functional

---

## 4. Phase 2 — Sigil: Certificate Authority and Control Plane

**Goal:** Build a working Sigil that can issue SPIFFE x509 certificates for services, store them, push them to connected agents via gRPC, and rotate them automatically.

**Why this comes before Kprobe mTLS:** Kprobe needs certificates to do TLS. Sigil is the source of those certificates. You cannot test Phase 3 without a running Sigil.

**Estimated time:** 6–8 weeks

---

### 4.1 What you build

#### Task 2.1 — Protobuf definitions (shared contract)

Define all messages and service RPCs in `.proto` files first. These become the binding contract between Go and Rust.

```protobuf
// sigil/proto/sigil.proto
syntax = "proto3";
package sigil.v1;

// The bundle pushed to each agent on connection and on rotation
message CertBundle {
  string service_id       = 1;
  bytes  service_cert_pem = 2;  // x509 PEM
  bytes  root_ca_pem      = 3;  // Sigil root CA PEM
  int64  expires_at_unix  = 4;
  int64  rotate_at_unix   = 5;  // Proactive rotation hint
}

// The compiled policy pushed to each agent
message PolicyBundle {
  repeated AllowRule rules    = 1;
  bool               default_allow = 2;
  string             mtls_mode    = 3; // "enforce" | "permissive" | "off"
}

message AllowRule {
  string from_service = 1;
  repeated string to_services = 2;
}

// The stream Kprobe opens to Sigil at startup
service SigilAgent {
  rpc Connect(AgentHello) returns (stream AgentPush);
  rpc Ack(AgentAck) returns (AckResponse);
}

message AgentHello {
  string node_id    = 1;
  string cluster_id = 2;
  repeated string pod_service_ids = 3; // Services on this node at startup
}

message AgentPush {
  oneof payload {
    CertBundle   cert   = 1;
    PolicyBundle policy = 2;
  }
}
```

Generate Go and Rust clients from this definition before writing any logic.

---

#### Task 2.2 — Certificate Authority (CA)

Build the core CA in Go using the standard library `crypto/x509`.

Sigil CA responsibilities:
- Generate and persist a self-signed root CA key pair on first startup
- Issue leaf certificates for each service identity with SPIFFE URI in SAN
- Sign them with the root CA private key
- Return the leaf cert + root CA cert as a `CertBundle`
- Track issued certs in SQLite with serial number, service ID, expiry
- Revoke on demand (delete from SQLite + push empty bundle to agent)

SPIFFE URI format: `spiffe://meshlite.local/cluster/{clusterID}/ns/{namespace}/svc/{serviceName}`

---

#### Task 2.3 — Policy Engine

Parse `mesh.yaml` and compile allow rules into an in-memory graph:

```go
// internal/policy/engine.go
type PolicyEngine struct {
    rules       map[string]map[string]bool // src → dst → allowed
    defaultAllow bool
    mtlsMode    string
}

func (e *PolicyEngine) Evaluate(from, to string) Decision {
    if allowed, exists := e.rules[from][to]; exists && allowed {
        return Allow
    }
    if e.defaultAllow {
        return Allow
    }
    return Deny
}
```

---

#### Task 2.4 — Service Registry

Watch the Kubernetes API for pod events using `controller-runtime`:

- On pod create: register the service identity, issue cert, push to the node's Kprobe agent
- On pod delete: deregister, revoke cert, push revocation to agent
- On pod reschedule: issue new cert for new node assignment

---

#### Task 2.5 — Policy Distributor

Maintain one gRPC server-streaming connection per connected Kprobe agent:

- On agent connect: send all certs for services on that node + full policy
- On cert rotation: push new `CertBundle` to the relevant agent
- On policy change (new `mesh.yaml` applied): push new `PolicyBundle` to all agents
- Handle agent disconnect + reconnect with exponential backoff

---

#### Task 2.6 — Sigil API

REST + gRPC endpoints:

- `POST /api/v1/config` — accepts `mesh.yaml`, triggers policy recompilation and full push
- `GET /api/v1/certs` — list all issued certs and their expiry
- `GET /api/v1/policy` — return the current compiled policy
- `GET /healthz` — readiness/liveness probe
- gRPC `SigilAgent.Connect` — the persistent agent stream

---

#### Task 2.7 — Helm chart for Sigil

```yaml
# charts/sigil/templates/deployment.yaml
# Single Deployment, single replica, meshlite-system namespace
# Mounts a PersistentVolume for the SQLite database file
# Exposes port 8443 (gRPC + REST over TLS)
```

---

### 4.2 Testing Strategy — Phase 2

#### Test 2.A — CA issues a valid SPIFFE certificate

```bash
# Start Sigil locally (not in cluster yet)
go run ./sigil/cmd/server --config ./tests/fixtures/mesh-basic.yaml

# Use grpcurl to call the CA directly
grpcurl -plaintext localhost:8443 sigil.v1.SigilAgent/Connect

# Then separately, inspect the issued cert
# Expected: x509 cert with SAN containing spiffe://meshlite.local/cluster/...
openssl x509 -in /tmp/test-cert.pem -text -noout | grep URI
# Expected output: URI:spiffe://meshlite.local/cluster/dev/ns/default/svc/service-alpha
```

---

#### Test 2.B — Policy engine evaluates correctly

Write unit tests covering all cases before integration testing:

```go
// sigil/internal/policy/engine_test.go
func TestPolicyEngine(t *testing.T) {
    // Load this mesh.yaml:
    // allow:
    //   - from: api-gateway
    //     to: [auth, orders]
    //   - from: orders
    //     to: [payments]
    // default_allow: false

    engine := newEngineFromYAML(t, "testdata/mesh-basic.yaml")

    // Explicitly allowed
    assert.Equal(t, Allow, engine.Evaluate("api-gateway", "auth"))
    assert.Equal(t, Allow, engine.Evaluate("api-gateway", "orders"))
    assert.Equal(t, Allow, engine.Evaluate("orders", "payments"))

    // Explicitly denied (not in allow list + default_allow: false)
    assert.Equal(t, Deny, engine.Evaluate("auth", "payments"))
    assert.Equal(t, Deny, engine.Evaluate("payments", "api-gateway"))

    // Unknown services
    assert.Equal(t, Deny, engine.Evaluate("unknown", "auth"))
}
```

Target: **100% branch coverage on the policy engine**. This is the most critical logic in the system.

---

#### Test 2.C — Agent connection and cert push over gRPC

Write a fake Kprobe agent in Go to simulate the real Kprobe connecting:

```go
// tests/fixtures/fake-agent/main.go
func main() {
    conn, _ := grpc.Dial("localhost:8443", grpc.WithInsecure())
    client := sigilv1.NewSigilAgentClient(conn)

    stream, _ := client.Connect(ctx, &sigilv1.AgentHello{
        NodeId:    "test-node-1",
        ClusterId: "dev",
        PodServiceIds: []string{"service-alpha", "service-beta"},
    })

    for {
        push, err := stream.Recv()
        if err != nil { break }
        // Print whatever arrives
        fmt.Printf("Received push: %+v\n", push)
    }
}
```

```bash
# Start Sigil + fake agent
go run ./sigil/cmd/server &
go run ./tests/fixtures/fake-agent/main.go

# Expected log output from fake agent:
# Received push: cert { service_id:"service-alpha" ... }
# Received push: cert { service_id:"service-beta" ... }
# Received push: policy { rules:[...] default_allow:false }
```

---

#### Test 2.D — Cert rotation pushes automatically

```bash
# Issue a cert with a 30-second TTL (test mode flag)
go run ./sigil/cmd/server --test-cert-ttl=30s

# Connect the fake agent and watch
go run ./tests/fixtures/fake-agent/main.go

# After ~25 seconds:
# Expected: new CertBundle pushed automatically for each service
# Verify: new cert has a later expires_at_unix than the previous one
# Verify: old cert is no longer in SQLite
```

---

#### Test 2.E — Deploy Sigil in the kind cluster and verify

```bash
helm install sigil ./charts/sigil -n meshlite-system --create-namespace

kubectl get pods -n meshlite-system
# Expected: sigil-xxx Running

kubectl logs -n meshlite-system deploy/sigil
# Expected: "Sigil CA initialized", "gRPC server listening on :8443"

# Port-forward and hit the health endpoint
kubectl port-forward -n meshlite-system svc/sigil 8443:8443
curl http://localhost:8443/healthz
# Expected: {"status":"ok"}
```

---

### 4.3 Exit Criteria — Phase 2

- [ ] Sigil generates a valid self-signed root CA on first startup and persists it
- [ ] Issued certs are valid SPIFFE SVIDs verifiable with `openssl verify`
- [ ] Policy engine unit tests pass with 100% branch coverage
- [ ] Fake agent connects via gRPC and receives correct certs + policy within 2 seconds
- [ ] Cert rotation pushes to connected agents automatically before TTL expiry
- [ ] `POST /api/v1/config` with a new `mesh.yaml` pushes updated policy to all connected agents within 5 seconds
- [ ] Sigil pod restarts cleanly and reconnects all agents without re-issuing certs unnecessarily
- [ ] Sigil runs in kind cluster, passes health checks, and consumes under 80MB RAM at idle

---

## 5. Phase 3 — Kprobe: Full mTLS and Policy Enforcement

**Goal:** Kprobe connects to Sigil, receives real certificates, performs a genuine TLS 1.3 mutual handshake between two pods, enforces policy, and delivers plain HTTP to the destination — all transparently.

**Why now:** Phase 1 proved interception works. Phase 2 built the cert source. Phase 3 wires them together. This is the first moment MeshLite actually does something useful.

**Estimated time:** 8–10 weeks

---

### 5.1 What you build

#### Task 3.1 — Sigil client in Rust

Port the gRPC agent connection from the Go fake agent into real Rust using `tonic` (the Rust gRPC library). This client:

- Opens a persistent gRPC stream to Sigil on Kprobe startup
- Receives `CertBundle` pushes and writes them into `CertStore`
- Receives `PolicyBundle` pushes and writes them into `PolicyCache`
- Reconnects with exponential backoff on disconnect

```rust
// kprobe/kprobe-userspace/src/sigil_client.rs
pub struct SigilClient {
    cert_store: Arc<RwLock<CertStore>>,
    policy_cache: Arc<RwLock<PolicyCache>>,
}

impl SigilClient {
    pub async fn run(&self, endpoint: String) {
        loop {
            match self.connect_and_stream(&endpoint).await {
                Ok(_) => {},
                Err(e) => {
                    warn!("Sigil stream error: {e}, reconnecting in 5s");
                    sleep(Duration::from_secs(5)).await;
                }
            }
        }
    }
}
```

---

#### Task 3.2 — CertStore and PolicyCache

Thread-safe in-memory stores. Used by both the Sigil client (writer) and the eBPF handler (reader). Must support atomic swap — old cert stays valid while new one is being written.

```rust
// CertStore: service_id → CertBundle
pub struct CertStore {
    inner: RwLock<HashMap<String, CertBundle>>,
}

// PolicyCache: (src_service_id, dst_service_id) → Decision
pub struct PolicyCache {
    rules: RwLock<HashMap<(String, String), Decision>>,
    default_allow: AtomicBool,
}
```

---

#### Task 3.3 — TLS Engine using rustls

The TLS engine performs the actual mTLS handshake on behalf of intercepted connections:

**Outbound (egress) path:**
1. Receive intercepted plain TCP connection from eBPF
2. Look up source service cert from CertStore
3. Initiate `rustls::ClientConnection` as the source service
4. Complete TLS 1.3 handshake with the destination Kprobe's TLS engine
5. Forward encrypted bytes over the real network socket

**Inbound (ingress) path:**
1. Receive encrypted TLS bytes from the network
2. Initiate `rustls::ServerConnection` using the destination service cert
3. Verify the peer's certificate against the Sigil root CA
4. Check PolicyCache: is source allowed to call destination?
5. If allowed: decrypt and deliver plain bytes to the destination pod
6. If denied: close connection immediately, log denial

---

#### Task 3.4 — Identity resolution

Map pod IPs to service identities using the Kubernetes downward API and pod metadata:

- On node startup: enumerate all pod IPs on this node → service name mapping
- On pod create/delete: update the mapping
- On packet intercept: look up source IP and dest IP in this map to get service identities

---

#### Task 3.5 — Connect eBPF program to TLS engine

The eBPF program from Phase 1 currently just logs packets. Now it needs to redirect them:

- Egress: instead of `TC_ACT_OK`, redirect the packet to a userspace socket where the TLS engine picks it up
- Ingress: the TLS engine writes decrypted bytes back to the pod's socket

Use `TC_ACT_REDIRECT` combined with a `AF_XDP` or `sockmap` approach to route packets between kernel and userspace TLS engine efficiently.

---

### 5.2 Testing Strategy — Phase 3

#### Test 3.A — Kprobe connects to Sigil and receives certs

```bash
# Start Sigil in kind cluster
helm install sigil ./charts/sigil -n meshlite-system --create-namespace

# Start Kprobe as DaemonSet (privileged, hostNetwork: true)
helm install kprobe ./charts/kprobe -n meshlite-system

# Watch Kprobe logs
kubectl logs -n meshlite-system daemonset/kprobe -f

# Expected log sequence:
# [kprobe] Connected to Sigil at sigil.meshlite-system.svc:8443
# [kprobe] Received CertBundle for service-alpha (expires in 24h)
# [kprobe] Received CertBundle for service-beta (expires in 24h)
# [kprobe] Received PolicyBundle (3 rules, default_allow: false)
# [kprobe] eBPF program loaded on eth0
# [kprobe] Enforcement active — intercepting pod traffic
```

---

#### Test 3.B — mTLS handshake happens between two pods

```bash
# Deploy test services
kubectl apply -f tests/fixtures/test-services.yaml

# Make a request from service-alpha to service-beta
kubectl exec -it deploy/service-alpha -- curl http://service-beta:8080

# Expected: HTTP 200 — the request succeeds (mTLS is transparent)

# Now verify the handshake actually happened in Kprobe logs
kubectl logs -n meshlite-system daemonset/kprobe | grep "TLS"
# Expected:
# [kprobe] TLS handshake: service-alpha → service-beta ✅ (peer cert verified)
# [kprobe] Request forwarded: service-alpha → service-beta 200 OK 12ms
```

---

#### Test 3.C — Policy DENY blocks traffic

```bash
# Apply a mesh.yaml that only allows service-alpha → service-beta
# but does NOT allow service-beta → service-alpha
kubectl apply -f tests/fixtures/mesh-one-way.yaml

# This should SUCCEED (allowed)
kubectl exec -it deploy/service-alpha -- curl http://service-beta:8080
# Expected: HTTP 200

# This should FAIL (denied by policy)
kubectl exec -it deploy/service-beta -- curl http://service-alpha:8080
# Expected: connection refused or timeout (not HTTP 403 — the TCP connection is dropped)

# Verify denial is logged
kubectl logs -n meshlite-system daemonset/kprobe | grep "DENY"
# Expected:
# [kprobe] POLICY DENY: service-beta → service-alpha (rule: default_allow=false)
```

---

#### Test 3.D — Tampered certificate is rejected

```bash
# Generate a self-signed cert that is NOT from Sigil
openssl req -x509 -newkey rsa:2048 -keyout /tmp/fake-key.pem \
  -out /tmp/fake-cert.pem -days 1 -nodes \
  -subj "/CN=service-alpha"

# Start a TLS server using the fake cert on a test pod
# Attempt to connect to it from service-alpha (Kprobe will try to verify)

# Expected in Kprobe logs:
# [kprobe] TLS REJECTED: cert not signed by Sigil root CA
# [kprobe] Connection dropped: invalid peer certificate
```

**This is the most important security test in the entire project. It must pass.**

---

#### Test 3.E — Performance: mTLS overhead

```bash
# Run the same load test as Phase 1 Test 1.D but now with full mTLS active

# Baseline (no Kprobe): record p50, p95, p99
kubectl exec -it deploy/service-alpha -- \
  hey -n 10000 -c 50 http://service-beta:8080

# With Kprobe + mTLS: same test
# Target: p99 overhead under 3ms versus baseline
# If over 3ms: profile the TLS handshake — likely the cert lookup is not cached
```

---

#### Test 3.F — Cert rotation does not drop connections

```bash
# Start a long-running HTTP connection (keep-alive, streaming response)
kubectl exec -it deploy/service-alpha -- \
  curl --no-buffer http://service-beta:8080/stream &

# Trigger cert rotation manually via meshctl
meshctl rotate --service service-alpha

# The streaming connection should NOT be interrupted
# New connections after rotation should use the new cert
# Verify in Kprobe logs:
# [kprobe] CertStore updated for service-alpha (atomic swap)
# [kprobe] Old cert remains valid for 60s overlap window
```

---

#### Test 3.G — Node failure: Kprobe restarts cleanly

```bash
# Kill the Kprobe pod on a worker node
kubectl delete pod -n meshlite-system -l app=kprobe --field-selector spec.nodeName=worker-1

# DaemonSet should restart it automatically (Kubernetes behaviour)
# Within 30 seconds, Kprobe should reconnect to Sigil and resume enforcement

# Test traffic during the restart window
# Expected: traffic between pods on OTHER nodes is unaffected
# Traffic involving worker-1 pods: brief outage until Kprobe reconnects
```

---

### 5.3 Exit Criteria — Phase 3

- [ ] Kprobe connects to Sigil on startup and receives certs + policy within 10 seconds
- [ ] pod-to-pod requests succeed transparently with mTLS active — zero application changes required
- [ ] Policy ALLOW and DENY work correctly and consistently across 1000 test requests
- [ ] A certificate not signed by Sigil root CA is rejected 100% of the time
- [ ] p99 mTLS overhead is under 3ms versus baseline
- [ ] Cert rotation pushes to Kprobe and takes effect without dropping existing connections
- [ ] Kprobe restart (pod delete) resumes enforcement within 30 seconds
- [ ] Permissive mode allows all traffic but logs it — no enforcement, observation only

---

## 6. Phase 4 — Conduit: Cross-Cluster Gateway

**Goal:** Traffic from a service in Cluster 1 reaches a service in Cluster 2 with full mTLS at the boundary — both Conduit instances verify each other's cluster identity using the shared Sigil root CA.

**Why now:** Same-cluster mTLS is proven in Phase 3. Conduit is built on the same TLS foundations — the shared Rust TLS library from Kprobe is reused directly.

**Estimated time:** 6–8 weeks

---

### 6.1 What you build

#### Task 4.1 — Shared TLS library (Rust crate)

Extract the TLS engine, CertStore, and Sigil client from Kprobe into a shared Rust library crate that both Kprobe and Conduit depend on. This is the code reuse that justified choosing Rust for both.

```
meshlite/
├── crates/
│   └── meshlite-tls/     # Shared: TLS engine, CertStore, Sigil client
├── kprobe/               # Depends on meshlite-tls
└── conduit/              # Depends on meshlite-tls
```

---

#### Task 4.2 — Conduit Egress

The outbound gateway at the Cluster 1 edge:

- Listens on a cluster-internal address for traffic from Kprobe that is destined for another cluster
- Accepts the intra-cluster connection (Kprobe uses its service cert for this leg)
- Strips the intra-cluster TLS, extracts the destination cluster + service
- Checks cross-cluster policy from PolicyCache
- Opens a NEW TLS 1.3 connection to Conduit Ingress using the cluster boundary certificate
- Forwards encrypted bytes over the internet/VPN
- Records boundary TelemetryRecords

---

#### Task 4.3 — Conduit Ingress

The inbound gateway at the Cluster 2 edge:

- Listens on a public or VPN-reachable address
- Accepts TLS connections from Conduit Egress
- Verifies the peer cluster cert against the shared Sigil root CA
- Checks cross-cluster policy (both ends enforce it — belt and braces)
- Resolves the destination service to the correct node in Cluster 2
- Forwards plain traffic to the destination node's Kprobe via intra-cluster mTLS
- Records boundary TelemetryRecords

---

#### Task 4.4 — Sigil cross-cluster federation

Extend Sigil to support multiple clusters:

- Accept enrollment from Cluster 2's Kprobe and Conduit agents
- Issue per-cluster intermediate CA certs (not just leaf certs)
- Distribute the shared root CA cert to both clusters so they can verify each other
- Compile and push cross-cluster policy (`from: cluster-1/service-a to: cluster-2/service-b`)

---

#### Task 4.5 — Helm charts for Conduit

Deploy Conduit Egress and Ingress as Deployments (not DaemonSets — one per cluster, not one per node):

```yaml
# Conduit Ingress needs a Service of type LoadBalancer or NodePort
# so Cluster 1's Conduit Egress can reach it from outside Cluster 2
```

---

### 6.2 Testing Strategy — Phase 4

#### Test 4.A — Two kind clusters can reach each other

```bash
# Verify network connectivity between the two kind clusters before any MeshLite
# kind clusters on the same machine share a Docker network

# From a pod in cluster-1, curl the NodePort of a service in cluster-2
kubectl --context kind-cluster-1 exec -it deploy/service-alpha -- \
  curl http://<cluster-2-node-ip>:<nodeport>/

# Expected: HTTP 200 (plain, no mTLS yet)
# This verifies the network path before Conduit is involved
```

---

#### Test 4.B — Conduit Egress and Ingress both receive their cluster boundary certs

```bash
# Install MeshLite on both clusters pointing at the same Sigil
helm --kube-context kind-cluster-1 install conduit-egress ./charts/conduit \
  --set mode=egress \
  --set sigil.endpoint=<sigil-address>

helm --kube-context kind-cluster-2 install conduit-ingress ./charts/conduit \
  --set mode=ingress \
  --set sigil.endpoint=<sigil-address>

# Check logs on Conduit Egress
kubectl --context kind-cluster-1 logs deploy/conduit-egress
# Expected:
# [conduit] Connected to Sigil
# [conduit] Received cluster boundary cert for cluster-1
# [conduit] Ready — listening for cross-cluster traffic

# Check logs on Conduit Ingress
kubectl --context kind-cluster-2 logs deploy/conduit-ingress
# Expected:
# [conduit] Connected to Sigil
# [conduit] Received cluster boundary cert for cluster-2
# [conduit] Ready — listening on :443 for inbound cross-cluster mTLS
```

---

#### Test 4.C — Cross-cluster mTLS handshake succeeds

```bash
# Apply a mesh.yaml that allows service-alpha (cluster-1) to call service-beta (cluster-2)
meshctl apply -f tests/fixtures/mesh-cross-cluster.yaml

# Make the request
kubectl --context kind-cluster-1 exec -it deploy/service-alpha -- \
  curl http://service-beta.cluster-2.meshlite.local/

# Expected: HTTP 200

# Verify in Conduit Egress logs:
# [conduit] Cross-cluster handshake: cluster-1 → cluster-2 ✅
# [conduit] Peer cert verified (chain: cluster-2-intermediate → sigil-root) ✅

# Verify in Conduit Ingress logs:
# [conduit] Inbound from cluster-1 ✅
# [conduit] Peer cert verified (chain: cluster-1-intermediate → sigil-root) ✅
```

---

#### Test 4.D — Cross-cluster policy DENY

```bash
# Attempt an unauthorized cross-cluster call (not in allow list)
kubectl --context kind-cluster-1 exec -it deploy/service-beta -- \
  curl http://service-alpha.cluster-2.meshlite.local/

# Expected: connection refused
# Conduit Egress logs:
# [conduit] POLICY DENY: cluster-1/service-beta → cluster-2/service-alpha
```

---

#### Test 4.E — Cluster 2 certificate forged — is it rejected?

```bash
# Generate a self-signed cert pretending to be cluster-2
# Try to establish a TLS connection to Conduit Ingress using this fake cert

# Expected: TLS handshake failure
# Conduit Ingress logs:
# [conduit] TLS REJECTED: peer cert not signed by Sigil root CA
# [conduit] Connection dropped from <ip>
```

---

#### Test 4.F — Cross-cluster latency overhead

```bash
# Baseline: direct pod-to-pod across clusters (no Conduit, plain HTTP)
hey -n 5000 -c 20 http://<cluster-2-service-direct>

# With Conduit + cross-cluster mTLS
hey -n 5000 -c 20 http://service-beta.cluster-2.meshlite.local/

# Acceptable overhead: cross-cluster TLS adds ~2–5ms to an already-latent path
# If overhead is over 10ms: TLS session resumption is not working correctly
```

---

### 6.3 Exit Criteria — Phase 4

- [ ] Conduit Egress and Ingress both receive cluster boundary certs from Sigil on startup
- [ ] A cross-cluster request from Cluster 1 to Cluster 2 succeeds end to end with HTTP 200
- [ ] Both Conduit instances log cert verification success for each cross-cluster handshake
- [ ] A forged cluster cert is rejected 100% of the time — connection never reaches the destination service
- [ ] Cross-cluster policy DENY prevents traffic between clusters not in the allow list
- [ ] Cross-cluster p99 latency overhead from Conduit is under 5ms
- [ ] Conduit Ingress restart does not affect in-flight connections on Conduit Egress (graceful drain)
- [ ] Services in both clusters still see plain HTTP at the application layer — zero code changes

---

## 7. Phase 5 — Trace and meshctl: Observability and CLI

**Goal:** Every request that Kprobe or Conduit processes produces a TelemetryRecord that flows to Trace. The dashboard shows a live service graph, latency histograms, and error rates. meshctl makes all of this operable from the terminal.

**Why last:** Trace is built on top of the enforcement layer — it needs real traffic flowing through Kprobe and Conduit to have anything to visualise. meshctl is built last because the APIs it wraps (Sigil, Trace) are finalised in earlier phases.

**Estimated time:** 6–8 weeks

---

### 7.1 What you build

#### Task 5.1 — TelemetryRecord emission in Kprobe and Conduit

Add async telemetry emission to both components:

```rust
// After every successful (or denied) request:
let record = TelemetryRecord {
    source:       resolved_source_identity,
    destination:  resolved_dest_identity,
    cluster_id:   env::var("CLUSTER_ID").unwrap(),
    leg:          TrafficLeg::IntraCluster,
    latency_ms:   elapsed.as_millis() as i32,
    status_code:  response_status,
    tls_verified: handshake_result.success,
    policy_allowed: policy_decision == Decision::Allow,
    timestamp:    SystemTime::now(),
};

// Non-blocking send to Trace agent
telemetry_tx.try_send(record).ok(); // Drop if channel full — metrics loss OK
```

---

#### Task 5.2 — Trace backend (Go)

A lightweight Go server that:

- Accepts TelemetryRecord streams from Kprobe and Conduit via gRPC
- Aggregates into Prometheus-compatible metrics:
  - `meshlite_requests_total{src, dst, status}` — counter
  - `meshlite_request_duration_ms{src, dst, le}` — histogram
  - `meshlite_policy_denials_total{src, dst}` — counter
  - `meshlite_tls_failures_total{src, dst, reason}` — counter
- Exposes `/metrics` endpoint (Prometheus scrape target)
- Serves the React frontend as embedded static files
- Exposes a WebSocket endpoint for the live service graph

---

#### Task 5.3 — Trace frontend (React + TypeScript)

Three views:

**Service graph:** A force-directed graph (using D3.js) where each node is a service and each edge is a traffic flow. Edge thickness = request rate. Edge colour = error rate (green → yellow → red).

**Latency view:** Per-service-pair latency histogram showing p50, p95, p99 over a 5-minute sliding window.

**Policy log:** A live feed of recent policy denials — source, destination, timestamp, cluster.

---

#### Task 5.4 — meshctl commands

```bash
meshctl apply  -f mesh.yaml          # Apply config to Sigil
meshctl status                        # Show all services, cert expiry, policy summary
meshctl logs   --service service-alpha # Tail Trace logs for a specific service
meshctl rotate --service service-alpha # Force cert rotation
meshctl verify --from svc-a --to svc-b # Test if a specific call is allowed by policy
meshctl version                        # Show MeshLite component versions
```

---

### 7.2 Testing Strategy — Phase 5

#### Test 5.A — TelemetryRecords arrive in Trace

```bash
# Start Trace
helm install trace ./charts/trace -n meshlite-system

# Generate 100 requests
kubectl exec -it deploy/service-alpha -- \
  hey -n 100 http://service-beta:8080

# Scrape Trace metrics endpoint
curl http://localhost:9090/metrics | grep meshlite_requests_total
# Expected:
# meshlite_requests_total{src="service-alpha",dst="service-beta",status="200"} 100
```

---

#### Test 5.B — Policy denial appears in Trace

```bash
# Attempt 10 denied requests
for i in $(seq 1 10); do
  kubectl exec -it deploy/service-beta -- curl http://service-alpha:8080 || true
done

curl http://localhost:9090/metrics | grep meshlite_policy_denials_total
# Expected:
# meshlite_policy_denials_total{src="service-beta",dst="service-alpha"} 10
```

---

#### Test 5.C — Dashboard service graph renders correctly

```bash
# Port-forward Trace UI
kubectl port-forward -n meshlite-system svc/trace 3000:3000

# Open http://localhost:3000 in browser
# Expected:
# - Two nodes visible: service-alpha, service-beta
# - One green edge: service-alpha → service-beta (allowed, low error rate)
# - No edge for service-beta → service-alpha (denied, no successful traffic)
```

---

#### Test 5.D — meshctl verify command

```bash
meshctl verify --from service-alpha --to service-beta
# Expected:
# ✅ ALLOW — rule: "from: service-alpha to: [service-beta]" (mesh-basic.yaml line 7)

meshctl verify --from service-beta --to service-alpha
# Expected:
# ❌ DENY — no matching allow rule. default_allow: false
```

---

#### Test 5.E — Cross-cluster metrics appear in Trace Central

```bash
# Make 50 cross-cluster requests
for i in $(seq 1 50); do
  kubectl --context kind-cluster-1 exec -it deploy/service-alpha -- \
    curl http://service-beta.cluster-2.meshlite.local/
done

# Check Trace Central (unified view)
curl http://localhost:9090/metrics | grep cross_cluster
# Expected:
# meshlite_requests_total{src="cluster-1/service-alpha",dst="cluster-2/service-beta",leg="cross_cluster",status="200"} 50
```

---

### 7.3 Exit Criteria — Phase 5

- [ ] Every allowed request produces a TelemetryRecord visible in Trace metrics within 5 seconds
- [ ] Every denied request increments the denial counter in Trace
- [ ] `/metrics` endpoint is valid Prometheus format — `promtool check metrics` passes
- [ ] Dashboard service graph renders correctly with real traffic data
- [ ] Cross-cluster requests appear in Trace Central with correct `leg` classification
- [ ] `meshctl apply` applies a new `mesh.yaml` and policy is live in Kprobe within 10 seconds
- [ ] `meshctl verify` correctly predicts ALLOW/DENY for any service pair against live policy
- [ ] `meshctl status` shows all services, cert expiry times, and current policy summary

---

## 8. Integration Testing Strategy

> Once all phases are complete, run these full-system tests before any release. These are the tests that find the bugs that unit tests and phase tests miss.

### 8.1 End-to-end test suite

Located in `tests/e2e/`. Each test:

1. Spins up a fresh kind cluster (or two for cross-cluster)
2. Installs MeshLite via Helm
3. Deploys test services
4. Applies a `mesh.yaml`
5. Makes requests and asserts outcomes
6. Tears down

```bash
# Run all e2e tests
go test ./tests/e2e/... -v -timeout 30m

# Individual scenarios
go test ./tests/e2e/... -run TestSameClusterMTLS
go test ./tests/e2e/... -run TestCrossClusterMTLS
go test ./tests/e2e/... -run TestPolicyEnforcement
go test ./tests/e2e/... -run TestCertRotation
go test ./tests/e2e/... -run TestNodeFailure
```

---

### 8.2 Chaos tests

| Scenario | How to test | Expected behaviour |
|---|---|---|
| Sigil goes down | `kubectl delete pod -n meshlite-system sigil-xxx` | Kprobe uses cached certs. Reconnects when Sigil restarts. No traffic interruption |
| Kprobe pod killed mid-request | `kubectl delete pod` during load test | Requests on other nodes unaffected. Recovering node has brief outage |
| Cert rotation during peak load | Run rotation while `hey` is running 10k requests | Zero request failures. All requests complete with either old or new cert |
| New service added mid-flight | Apply new `mesh.yaml` during load test | New service cert issued and enforced within 10s. Existing services unaffected |
| Network partition between clusters | Block traffic between kind clusters mid-request | Conduit Egress returns connection error. Cluster 1 intra-cluster traffic unaffected |

---

### 8.3 Security tests

| Test | What it verifies |
|---|---|
| Present a cert from a different root CA | Kprobe and Conduit both reject — handshake failure |
| Replay an expired cert | Kprobe rejects — cert expiry check in rustls |
| Send traffic to a port not registered in mesh.yaml | Policy DENY — dropped at tc layer |
| Attempt to enroll as a service that already exists | Sigil rejects — duplicate identity conflict |
| kubectl exec into a pod and call another service manually | Same enforcement — eBPF is per-node, not per-process |

---

### 8.4 Load test targets before v0.1 release

Run these on a 3-node kind cluster with realistic service count (8 services, 20 allow rules):

| Metric | Target |
|---|---|
| Throughput | 10,000 req/s sustained across 8 service pairs |
| p50 latency overhead | < 1ms vs baseline |
| p99 latency overhead | < 3ms vs baseline |
| Kprobe memory per node | < 50 MB |
| Sigil memory at 10 agents | < 80 MB |
| Cert rotation time (push to all agents) | < 5 seconds |
| Policy update time (mesh.yaml change to enforcement) | < 10 seconds |

---

## 9. Milestone Summary

| Phase | What is done | Timeline |
|---|---|---|
| **Environment** | kind clusters, toolchain, repo structure | Week 1–2 |
| **Phase 1** | eBPF intercepts packets. No disruption. Performance baseline measured | Week 3–6 |
| **Phase 2** | Sigil issues SPIFFE certs, compiles policy, pushes to agents via gRPC | Week 7–14 |
| **Phase 3** | Kprobe does real mTLS with Sigil certs. Policy enforced. Same-cluster complete | Week 15–24 |
| **Phase 4** | Conduit handles cross-cluster mTLS. Two kind clusters. Full cross-cluster flow | Week 25–32 |
| **Phase 5** | Trace dashboard live. meshctl operable. Full system integrated | Week 33–40 |
| **Integration** | Chaos tests, security tests, load tests, e2e suite passes | Week 41–44 |

---

### The rule above all others

> **Never declare a phase complete based on "it seemed to work."**
> Every exit criteria checkbox must be ticked with a specific command run and specific output observed. The test output is the proof. If a test is hard to write, that is a signal the component is not designed correctly — fix the design, not the test.

---

*End of Development Plan v0.1*

> **Next document:** MeshLite — Technical Deep Dive  
> Covers: Sigil CA key generation internals · eBPF program structure in Aya · Conduit TLS session management · Full bootstrap sequence from `helm install` to first secured request