# MeshLite — Phase 3 Approach
## Kprobe eBPF Agent: Sigil Integration and Policy Enforcement

> **Status:** Approach — under review
> **Date:** April 8, 2026
> **Follows:** Phase 2 Outcome Report (`docs/phase-2/phase2-outcome-report.md`)
> **Do not start the runbook until this document is reviewed and agreed.**

---

## 1. Goal

Prove that the eBPF program from Phase 1 can enforce service-to-service policy decisions delivered by Sigil (Phase 2): a Kprobe agent running as a DaemonSet connects to Sigil, receives cert and policy updates, maps service identities to pod IPs on its node, and programs an eBPF verdict map so that the TC hook allows or drops traffic determined by the active mesh policy.

---

## 2. Scope

### In Scope

| Item | Description |
|---|---|
| **Sigil gRPC client (Rust)** | `tonic` gRPC client in kprobe-userspace; sends `AgentHello`, streams `AgentPush` from Sigil |
| **CertStore** | In-memory store for `CertBundle` per service; provides root CA PEM and leaf cert PEM for mTLS reconnect |
| **PolicyCache** | Holds current `PolicyBundle`; exposes `permit(src_ip, dst_ip) → bool` |
| **PodWatcher** | Uses `kube` Rust crate to watch pods on the local node; maps `app` label → `Vec<Ipv4Addr>` |
| **VerdictSync** | Reconciles PolicyCache + PodWatcher into the eBPF `VERDICT_MAP`; re-runs on every policy or pod event |
| **eBPF program changes** | Adds `VERDICT_MAP: HashMap<PacketKey, u8>` and `POLICY_FLAGS: Array<u32>`; TC hook returns `TC_ACT_SHOT` on DENY |
| **mTLS on Kprobe→Sigil channel** | Kprobe bootstraps over plaintext, receives cert, reconnects with mTLS using its SPIFFE leaf cert + Sigil root CA |
| **Sigil gRPC TLS** | Sigil generates its own server cert from the root CA; gRPC listener upgraded to TLS |
| **Kprobe Helm chart** | DaemonSet in `meshlite-system`; `privileged: true` + `SYS_ADMIN` + `NET_ADMIN`; Sigil address via env var |
| **Integration test** | `mesh-one-way.yaml` policy verifies one-directional traffic enforcement; live reload test verifies eBPF map updates |

### Explicitly Out of Scope

- **Pod-to-pod mTLS** — services present plain HTTP to each other. TLS termination inside eBPF is not in scope. Phase 4 evaluates Conduit for cross-cluster mTLS.
- **Conduit (cross-cluster gateway)** — Phase 4.
- **Trace (observability dashboard)** — Phase 5.
- **meshctl CLI** — Phase 5.
- **Multi-node verdict coordination** — each Kprobe DaemonSet pod manages its own node's eBPF map independently. Cross-node state sync is Phase 4.
- **Production hardening** (cert revocation via eBPF, HSM, SQLite encryption) — deferred.
- **Metrics collection from eBPF** — Kprobe logs intercept events to stdout only; Prometheus integration is Phase 5.
- **eBPF ingress enforcement** — Phase 3 enforces on egress only (matching Phase 1's TC egress hook). Ingress enforcement is deferred.

---

## 3. Components

All new code is in these locations. Everything else in the repo is unchanged unless noted.

```
kprobe/
├── build.rs                              ← NEW: tonic-build compiles sigil.proto → Rust types
├── kprobe-userspace/
│   ├── Cargo.toml                        ← ADD: tonic, prost, kube, k8s-openapi, rustls, pem
│   └── src/
│       ├── main.rs                       ← REWRITE: orchestrates all tasks; mTLS reconnect state machine
│       ├── sigil_client.rs               ← NEW: tonic gRPC client; AgentHello send; AgentPush stream
│       ├── cert_store.rs                 ← NEW: CertBundle storage; provides PEM bytes for mTLS
│       ├── policy_cache.rs               ← NEW: PolicyBundle storage; permit(src_ip, dst_ip) → bool
│       ├── pod_watcher.rs                ← NEW: kube pod watch; service_id → Vec<Ipv4Addr> on local node
│       └── verdict_sync.rs              ← NEW: translates policy + pod IPs into eBPF VERDICT_MAP writes
└── kprobe-ebpf/
    └── src/
        └── main.rs                       ← CHANGE: add VERDICT_MAP + POLICY_FLAGS; TC hook reads both

sigil/
└── cmd/server/main.go                    ← CHANGE: gRPC listener upgraded to TLS using server cert from CA

charts/kprobe/
├── Chart.yaml                            ← NEW
├── values.yaml                           ← NEW
└── templates/
    ├── daemonset.yaml                    ← NEW: DaemonSet; privileged; env NODE_NAME, SIGIL_ADDR
    ├── rbac.yaml                         ← NEW: ServiceAccount + ClusterRole for pod list/watch
    └── _helpers.tpl                      ← NEW
```

### eBPF map design

```
VERDICT_MAP: HashMap<PacketKey, u8>
  key:   PacketKey { src_ip: u32, dst_ip: u32 }   // network byte order
  value: 0 = ALLOW, 1 = DENY

POLICY_FLAGS: Array<u32>
  [0]: default_allow flag — 0 = deny-all-unmatched, 1 = allow-all-unmatched
```

TC egress decision logic (updated `try_intercept`):

```
1. Parse IPv4 4-tuple as before.
2. Look up (src_ip, dst_ip) in VERDICT_MAP.
   a. Found, value = DENY (1) → TC_ACT_SHOT
   b. Found, value = ALLOW (0) → TC_ACT_OK
   c. Not found → read POLICY_FLAGS[0]:
      - 1 (allow-all-unmatched) → TC_ACT_OK
      - 0 (deny-all-unmatched)  → TC_ACT_SHOT
```

### mTLS reconnect state machine

```
State 1 — BOOTSTRAP:
  - Connect to Sigil plaintext (insecure channel)
  - Send AgentHello; wait for first CertBundle for local service
  - On receipt: save cert+key to CertStore; set state = UPGRADING

State 2 — UPGRADING:
  - Close plaintext connection
  - Build tonic TLS channel with: client cert = SPIFFE leaf, root CA = Sigil root
  - Reconnect; re-send AgentHello
  - Log: [SIGIL] mTLS reconnect node=<node_id>
  - Set state = CONNECTED_TLS; all subsequent pushes arrive on this channel

State 3 — CONNECTED_TLS:
  - Normal streaming operation
  - On disconnect: return to State 2 (already have cert)
```

---

## 4. Dependencies

The following must be working before Phase 3 starts:

| Dependency | Where verified |
|---|---|
| eBPF TC egress hook loads and fires (`kprobe_egress`) | Phase 1 exit criterion 1.A |
| `TC_ACT_OK` passes packets without corruption | Phase 1 exit criterion 1.B |
| Sigil runs in kind cluster; gRPC `SigilAgent.Connect` functional | Phase 2 exit criterion 2.C |
| `CertBundle` pushed on connect; `PolicyBundle` pushed on config reload | Phase 2 exit criteria 2.C, 2.D |
| `tests/fixtures/test-services.yaml` (service-alpha, service-beta) deployed | Phase 1 |
| `hack/dev-cluster.sh` creates `meshlite-dev` kind cluster | Phase 1 |
| `sigil.proto` compiled and stable | Phase 2 Architecture Decision #1 |

---

## 5. Exit Criteria

| ID | Criterion | Pass condition |
|---|:---|:---|
| **3.A** | Kprobe agent connects to Sigil | Agent pod starts on `meshlite-dev-worker`, logs `[SIGIL] connected node=meshlite-dev-worker cluster=dev`, and receives at least one `CertBundle` within 10 seconds of startup. |
| **3.B** | Allowed traffic passes through | With `mesh-one-way.yaml` active (service-alpha → service-beta ALLOW, default_deny), `curl` from inside a `service-alpha` pod to `service-beta:8080` returns HTTP 200. Agent log shows `[VERDICT] allow` entry for that src/dst pair. |
| **3.C** | Denied traffic is dropped | With the same policy, `curl` from inside a `service-beta` pod to `service-alpha:8080` does not return a response within 5 seconds. Agent log shows `[VERDICT] deny` entry. |
| **3.D** | Live policy reload updates eBPF map | After `POST /api/v1/config` with bidirectional allow policy, the previously blocked beta→alpha direction returns HTTP 200 within 5 seconds — without any kprobe pod restart. Agent log shows `[POLICY] updated rules=2`. |
| **3.E** | mTLS on Kprobe→Sigil channel | After bootstrap cert receipt, agent logs `[SIGIL] mTLS reconnect`. Subsequent `AgentPush` messages arrive on the TLS channel. Running `openssl s_client` against Sigil's gRPC port shows a valid cert signed by Sigil's root CA. |
| **3.F** | Enforcement resumes after restart | After `kubectl rollout restart daemonset/kprobe` in `meshlite-system`, the original `mesh-one-way.yaml` policy is fully enforced again (criteria 3.B and 3.C both pass) within 20 seconds. |

---

## 6. Risk Items

| Risk | Likelihood | Mitigation |
|---|:---:|---|
| **eBPF HashMap not accessible from both kernel and userspace** | Low | Use Aya's `HashMap` map type; pin the map at a stable path; test map read/write in isolation before wiring to TC hook. |
| **Pod IP discovery race** — pods may not be scheduled before kprobe agent starts | Medium | PodWatcher uses a `ListWatch` informer cache; VerdictSync waits for the cache to sync before populating the map. Log a warning if no pods are found after 30s. |
| **mTLS bootstrap chicken-and-egg** — agent has no cert on first connect | Low | Explicitly handled by the three-state reconnect machine. First connect is always plaintext; subsequent connections require a cert. Sigil's plaintext port remains open for bootstrap. |
| **Sigil gRPC TLS breaks fake-agent integration test** | Medium | Update the fake-agent's Go client to also support both plaintext and TLS, or keep a separate plaintext-only test port. Check Phase 2 test procedures still pass before Phase 3 test run. |
| **`TC_ACT_SHOT` drops kubelet heartbeats** — misclassifies node traffic as pod traffic | Low | Phase 1 proved pod traffic uses `10.244.x.x` CIDR; node traffic uses `172.18.x.x`. VerdictSync only inserts entries for pod CIDRs. Guard in eBPF: only consult VERDICT_MAP for `src_ip` in pod CIDR range. |
| **`kube` Rust crate version vs Kubernetes 1.34.1** | Low | Use `k8s-openapi` feature flag matching the actual cluster version. Test pod list/watch against the kind cluster before wiring to VerdictSync. |
| **Privileged DaemonSet blocked by Pod Security Admission** | Low | kind cluster in Phase 1/2 did not have PSA enforced in `meshlite-system` namespace. Verify namespace labels and add `privileged` label if needed. |
| **controller-runtime logger noise in Sigil** (deferred from Phase 2) | Low | Wire `ctrl.SetLogger` at Sigil startup before adding TLS to avoid noisy output masking TLS errors. |
| **Config reload pointer race in Sigil** (flagged Phase 2 AD #7) | Low | Phase 3 performs live reload test; if test flakiness is observed, add a `sync.RWMutex` around the policy engine pointer swap before proceeding. |

---

## Per-Phase Document Checklist Reminder

```
docs/phase-3/
├── phase3-approach.md         ✅  (this document)
├── phase3-runbook.md          ⬜  written next, before any code
└── phase3-outcome-report.md   ⬜  written after all tests pass
```

Do not start the runbook until this approach is reviewed and agreed.
