# MeshLite — Phase 3 Outcome Report
## Kprobe eBPF Agent: Sigil Integration and Policy Enforcement

---

## Header

| Field | Value |
|---|---|
| **Date** | April 11, 2026 |
| **Host OS** | Windows 11 + WSL2 (Ubuntu 24.04) |
| **WSL2 kernel** | `6.6.87.2-microsoft-standard-WSL2` |
| **Kubernetes** | `v1.29.2` (kind `v0.22.0`) |
| **Container runtime** | `containerd 1.7.13` |
| **Docker Desktop** | `29.3.1` |
| **Rust toolchain** | `nightly-2026-04-02` (`rustc 1.96.0-nightly`) |
| **Go** | `1.22.0` |
| **protoc** | `libprotoc 3.21.12` |
| **Helm** | `v3.20.1` |
| **kubectl** | `v1.34.1` (client) |
| **Cluster name** | `meshlite-dev` (3 nodes: control-plane, worker, worker2) |
| **kprobe image** | `meshlite/kprobe:phase3` (`sha256:a71f4f205f89...`) |
| **sigil image** | `meshlite/sigil:phase3` (`sha256:49d2a93a0ef0...`) |
| **Commit** | `e83da1f` — "phase-3: Sigil integration, mTLS, eBPF enforcement — all tests pass" |

---

## Executive Summary

**Phase 3 PASSES all six exit criteria.** The Kprobe eBPF agent now connects to Sigil via a Bootstrap→UpgradingTLS→ConnectedTLS mTLS state machine, receives `CertBundle` and `PolicyBundle` pushes, maps service identities to pod IPs cluster-wide, and programs the eBPF `VERDICT_MAP` so that the TC egress hook correctly allows or drops pod-to-pod traffic. Live policy reload updates the eBPF map in under 3 seconds without pod restart. Enforcement fully resumes within 20 seconds of a DaemonSet rollout. Four bugs were found and fixed during execution that were not present in the original runbook; all are documented below. The architecture is ready for Phase 4 (Conduit cross-cluster gateway).

---

## What Was Built

| Component | Description | File(s) |
|---|---|---|
| **eBPF enforcement maps** | `VERDICT_MAP: HashMap<PacketKey, u8>` + `POLICY_FLAGS: Array<u32>` added to eBPF program; TC hook reads both; dual pod-CIDR guard (`10.244.0.0/16`); TCP SYN-only enforcement | `kprobe/kprobe-ebpf/src/main.rs` |
| **CertStore** | In-memory per-`service_id` store; holds `leaf_cert_pem`, `root_ca_pem`, `key_pem`; `update(service_id, leaf, root, key)` + `build_tls_identity()` | `kprobe/kprobe-userspace/src/cert_store.rs` |
| **PolicyCache** | Holds current `PolicyBundle`; `is_allowed(from_svc, to_svc)`, `default_allow()` | `kprobe/kprobe-userspace/src/policy_cache.rs` |
| **PodWatcher** | `kube` crate; watches **all pods cluster-wide** (not node-local); `PodSnapshot: HashMap<String, Vec<Ipv4Addr>>` | `kprobe/kprobe-userspace/src/pod_watcher.rs` |
| **VerdictSync** | Translates PolicyCache + PodSnapshot into `VERDICT_MAP` writes; 78 entries for a 3-node kind cluster; writes `POLICY_FLAGS[0]` | `kprobe/kprobe-userspace/src/verdict_sync.rs` |
| **SigilClient** | Three-state mTLS reconnect machine (Bootstrap → UpgradingTLS → ConnectedTLS); Bootstrap on plaintext port 8444; mTLS on TLS port 8443; reads `pod_snapshot` dynamically at hello-build time | `kprobe/kprobe-userspace/src/sigil_client.rs` |
| **main.rs orchestration** | Spawns PodWatcher, SigilClient, VerdictSync; loads eBPF; attaches TC hook; perf event reader (pod-CIDR filtered) | `kprobe/kprobe-userspace/src/main.rs` |
| **Sigil CA `IssueWithDNS`** | New method; issues cert with DNS SANs for Sigil's gRPC listener; used at server startup | `sigil/internal/ca/ca.go` |
| **Sigil gRPC TLS** | gRPC listener upgraded from plaintext to TLS using server cert from root CA; `ClientAuth: tls.RequestClientCert` (allows plain-cert-TLS and mTLS clients) | `sigil/cmd/server/main.go` |
| **KeyPEM flow** | `Issue()` now returns PKCS8 `KeyPEM`; `CertBundle` proto gains `key_pem = 6`; distributor passes it through; server sets it in all three push sites | `sigil/internal/ca/ca.go`, `sigil/internal/distributor/distributor.go`, `sigil/cmd/server/main.go`, `sigil/proto/sigil.proto`, `sigil/internal/proto/sigil.pb.go` |
| **Kprobe Helm chart** | DaemonSet in `meshlite-system`; `privileged: true` + `SYS_ADMIN` + `NET_ADMIN`; env `NODE_NAME`, `SIGIL_ADDR`, `CLUSTER_ID`; ClusterRole for pod `list`/`watch` | `charts/kprobe/` |
| **Bidirectional test fixture** | New policy fixture for Test 3.D and 3.F | `tests/fixtures/mesh-bidirectional.yaml` |
| **Hack scripts** | `gen-proto.sh`, `check-sigil.sh`, `check-kprobe.sh`, `build-and-load.sh` | `hack/` |

---

## Concepts Verified

### 1. eBPF verdict map can enforce policy derived from a remote control plane

Sigil pushes `PolicyBundle` to kprobe via gRPC stream; VerdictSync translates it into `VERDICT_MAP` writes using live pod IPs from the Kubernetes API. The eBPF program reads the map at packet-intercept time and issues `TC_ACT_SHOT` or `TC_ACT_OK` accordingly. Test 3.B and 3.C prove the enforcement is accurate. Test 3.F proves it survives pod restarts.

**Why it matters for Phase 4:** The VERDICT_MAP mechanism is the enforcement primitive that Conduit will also depend on. Phase 4 does not need to change the eBPF program — only VerdictSync needs to learn cross-cluster peer IPs.

### 2. mTLS state machine bootstraps from a plaintext channel without pre-provisioned secrets

Kprobe has no credentials at startup. It connects to Sigil on a plaintext port, receives its first `CertBundle` (leaf cert + root CA + private key), and upgrades to a TLS channel using those credentials — all without operator intervention. The Bootstrap→UpgradingTLS→ConnectedTLS transition was observed in production logs: total time from pod start to `ConnectedTLS` was **2 seconds** in all runs.

**Why it matters for Phase 4:** Phase 4's Conduit gateway will also need bootstrapped credentials. The same pattern (plaintext bootstrap → cert distribution → mTLS upgrade) applies.

### 3. Cross-node policy requires cluster-wide pod discovery

Initially PodWatcher watched only local-node pods. Worker2 could not see `service-alpha`'s IP, so the `(alpha-IP, beta-IP)` VERDICT_MAP entry was never written on worker2. TCP SYN-ACK from beta (on worker2) was dropped even though alpha's outgoing SYN was allowed on worker. Changing to cluster-wide watch (removing the `spec.nodeName` filter) fixed this immediately. Final VERDICT_MAP size: **78 entries** across 3 nodes × N services.

**Why it matters for Phase 4:** Conduit will introduce external peer IPs. VerdictSync will need to learn those IPs from the Conduit registry, not just the Kubernetes pod API. The cluster-wide pod watch pattern must be extended.

### 4. Stateless eBPF enforcement requires connection-semantic awareness

The TC egress hook fires on every packet — including TCP SYN-ACK reply packets from `service-beta` back to `service-alpha`. Worker2's kprobe had no ALLOW entry for `(beta-IP, alpha-IP)` (the reverse direction), so it dropped SYN-ACKs, making established connections fail even for permitted directions. Fix: check TCP flags at offset 47; only enforce DENY on packets where SYN=1 and ACK=0 (new connection initiations). Established-flow packets (ACK set) always pass. This is locked in as Architecture Decision #4.

**Why it matters for Phase 4:** Any new IP pairs introduced by Conduit (external peer addresses) must also be handled as new-connection-only enforcement. The TCP SYN guard must remain in the eBPF program.

### 5. Live policy reload updates the eBPF map without pod restart

`POST /api/v1/config` → Sigil distributor pushes new `PolicyBundle` → SigilClient `ConnectedTLS` state receives it → VerdictSync re-computes and writes new VERDICT_MAP → enforcement changes. Observed time from config POST to direction becoming ALLOW in Test 3.D: **under 3 seconds**. Log evidence: `[POLICY] updated rules=2`.

---

## Test Results

| Test ID | Exit Criterion | Result | Measured Value |
|---|---|:---:|---|
| **3.A** | mTLS connect + CertBundle within 10s | ✅ | Bootstrap→ConnectedTLS in **2s**; CertBundles for 7 services (service-alpha, service-beta, sigil, kprobe, kindnet, local-path-provisioner, meshlite-dev-worker) |
| **3.B** | alpha→beta HTTP 200 + verdict=ALLOW in log | ✅ | `service-beta OK`, exit 0; `verdict=ALLOW` for `10.244.2.2:46366 → 10.244.1.2:8080` in kprobe-worker log |
| **3.C** | beta→alpha timeout + verdict=DENY in log | ✅ | `wget: download timed out`, exit 1; `verdict=DENY` for `10.244.1.2 → 10.244.2.2:8080` in kprobe-worker2 log |
| **3.D** | Live reload; previously-denied direction ALLOW within 5s | ✅ | `service-alpha OK` from beta pod within **~3s** of config POST; `[POLICY] updated rules=2` in log; no pod restart |
| **3.E** | `[sigil_client] mTLS reconnect` in log + TLS cert from root CA | ✅ | Log: `[sigil_client] mTLS reconnect node=meshlite-dev-worker cluster=dev`; openssl: `subject=O=MeshLite, CN=sigil`, `issuer=O=MeshLite, CN=MeshLite Root CA` |
| **3.F** | 3.B + 3.C both pass within 20s of DaemonSet rollout | ✅ | Post-rollout: `service-beta OK` (exit 0) and `wget: download timed out` (exit 1) both measured within **~5s** of rollout completion |

---

## Issues Encountered

| # | Issue | Root Cause | Resolution | Impact |
|---|---|---|---|---|
| **I-1** | `sigil.pb.go` missing `KeyPem` field | `key_pem = 6` was added to `sigil.proto` but the generated Go file was never regenerated | Ran `protoc` with `--go_out` and `--go-grpc_out` in WSL2 to regenerate | **Blocking** — distributor could not pass KeyPEM to proto CertBundle |
| **I-2** | `SigilClient.make_hello()` sent empty `pod_service_ids` | `pod_service_ids: Vec<String>` was populated at construction time before PodWatcher had run; Sigil received an empty list and never pushed CertBundles | Changed to `pod_snapshot: Arc<Mutex<PodSnapshot>>`; `make_hello()` reads keys dynamically at call time; always prepends `node_id` | **Blocking** — bootstrap loop ran forever; no CertBundles received |
| **I-3** | mTLS handshake failed with certificate/key mismatch | `CertStore::new(local_key_pem)` received a locally-generated ECDSA key; Sigil issued the leaf cert for a different key (its own CA-generated key); the cert and key were mismatched | End-to-end KeyPEM flow: `ca.go Issue()` encodes PKCS8 key → `distributor` passes `KeyPEM` in `CertBundle` → `server.go` sets it in all three push sites → proto `key_pem = 6` → `sigil_client` calls `cert_store.update(service_id, leaf, root, key_pem)` | **Blocking** — mTLS upgrade failed; kprobe could not reach ConnectedTLS |
| **I-4** | TCP SYN-ACK dropped on worker2 for allowed connections | PodWatcher was node-local; worker2 VERDICT_MAP had no entry for `(beta-IP, alpha-IP)` in allowed direction; stateless eBPF enforcement hit `default_deny`, dropping `service-alpha`'s SYN-ACK reply | Two sub-fixes: (a) PodWatcher changed to cluster-wide watch (removed `spec.nodeName` filter); (b) eBPF TCP flag check at offset 47: only deny new SYN (SYN=1, ACK=0), allow reply packets | **Blocking** — Test 3.B failed (TCP connection could not complete) |
| **I-5** | Kubernetes log buffer overflow hiding startup messages | `println!("[INTERCEPT]...")` fired on every intercepted packet including kubelet heartbeats (`172.18.x.x`), generating 200k+ lines. Startup `[sigil_client] mTLS reconnect` log was evicted from the 10MB k8s log buffer | Added pod-CIDR guard (`s[0]==10 && s[1]==244 || d[0]==10 && d[1]==244`) around the `println!` in `main.rs`; node-traffic INTERCEPT lines suppressed entirely | **Test 3.E** — log line existed but was unreadable; fix made all startup messages permanently visible |
| **I-6** | Bidirectional policy left active after Test 3.D | Cluster was stopped after Test 3.D completed; on restart, Sigil had the bidirectional policy in memory, making Test 3.C appear to fail | Re-applied one-way policy via `POST /api/v1/config` before running 3.E and 3.F | **Non-structural** — correct sequence issue; no code change needed |
| **I-7** | Docker Desktop not running after 2-day cluster pause | kind containers stopped; Docker Desktop was not auto-started | Started Docker Desktop, waited for daemon, then `docker start` on all kind containers | **Operational** — no code change needed |
| **I-8** | Misplaced `sigil.pb.go` / `sigil_grpc.pb.go` at repo root | `protoc` was run with output directed to `sigil/` instead of `sigil/internal/proto/` | Unstaged root-level duplicates; added them to `.gitignore`; canonical copies remain in `sigil/internal/proto/` | **Minor** — would have caused build confusion in Phase 4 |

---

## Architecture Decisions

These decisions were made during Phase 3 and are now locked in. Phase 4 must not contradict them without explicit discussion.

**AD-1: KeyPEM is distributed by Sigil, not generated client-side.**
Sigil's CA generates the private key and leaf cert together and pushes both to kprobe via `CertBundle.key_pem`. The original approach design described client-side key generation, which was abandoned because it requires a CSR round-trip that complicates the bootstrap state machine. The proto field `key_pem = 6` is now a permanent part of the contract.

**AD-2: PodWatcher watches all pods cluster-wide, not just local-node pods.**
The runbook specified `spec.nodeName` filtering. This was incompatible with cross-node enforcement: a kprobe on worker2 needs to know `service-alpha`'s IP (on worker) to write the correct `(alpha-IP, beta-IP)` VERDICT_MAP entry. Cluster-wide watch is the permanent approach. VERDICT_MAP size scales as O(pods² across all namespaces where policy applies).

**AD-3: Sigil exposes two ports — plaintext (8444) and TLS (8443).**
Bootstrap uses port 8444 (plaintext, no client cert required). After cert receipt, kprobe reconnects on port 8443 (TLS, client cert presented). Sigil sets `ClientAuth: tls.RequestClientCert` so that both plain-TLS (bootstrap hop) and mTLS (connected state) are accepted on the same port 8443, but the separate plaintext port 8444 is kept for initial Bootstrap to avoid a cert-before-cert chicken-and-egg problem.

**AD-4: eBPF enforcement applies only to new TCP connections (SYN without ACK).**
Established-flow packets (ACK set) always pass `TC_ACT_OK` regardless of verdict map contents. This preserves return traffic for permitted connections on nodes where the reverse direction has no explicit ALLOW entry. Implication: policy changes take effect on new connections only; open connections are not terminated. This is intentional and must not be changed without understanding the break-before-make implications.

**AD-5: [INTERCEPT] logging is filtered to pod CIDR only (10.244.0.0/16).**
Node-level traffic (`172.18.0.0/16`) is never logged to stdout. This was necessary to prevent Kubernetes log buffer overflow (default ~10MB) from evicting startup messages. Phase 4 monitoring / observability work must account for this: if metrics are needed for node→pod traffic, they must be collected via a separate mechanism (eBPF perf counter or Prometheus exporter), not via log scraping.

**AD-6: VERDICT_MAP key is (src_ip, dst_ip) in network byte order; capacity is 4096 entries.**
This is sufficient for the kind dev cluster (78 entries observed at steady state for 3 nodes × ~13 service pods). Phase 4 must revisit this limit if Conduit adds many external peer IPs. The capacity is set as a constant in `kprobe-ebpf/src/main.rs` (`HashMap::with_max_entries(4096, 0)`).

**AD-7: VerdictSync writes default_allow=true during bootstrap, then switches to policy value.**
`POLICY_FLAGS[0]` is set to `1` (allow-all) at startup before any CertBundle or PolicyBundle is received. This avoids dropping traffic during the ~2-second bootstrap window. Once the first PolicyBundle arrives via ConnectedTLS, it is overwritten with the policy value (`default_allow=false` for `mesh-one-way.yaml`). Phase 4 components must not assume enforcement is active during the first 5 seconds of a fresh pod start.

---

## Next Phase Readiness

### Verdict: READY for Phase 4

### What Phase 4 needs from Phase 3 (all confirmed working):

| Need | Status |
|---|---|
| eBPF `VERDICT_MAP` writable from userspace | ✅ 78 entries written at steady state |
| `POLICY_FLAGS[0]` controls default allow/deny | ✅ Observed transition from `true` (bootstrap) to `false` (policy) |
| TC egress hook enforces VERDICT_MAP on pod traffic | ✅ Tests 3.B + 3.C + 3.F prove enforcement |
| Sigil distributes `CertBundle` with leaf+root+key | ✅ `key_pem = 6` in proto; all three push sites confirmed |
| kprobe DaemonSet deployed and healthy (3 nodes) | ✅ All pods Running in `meshlite-system` |
| Policy live-reload propagates to eBPF in < 5s | ✅ ~3s measured in Test 3.D |

### What Phase 4 adds:

- **Conduit cross-cluster gateway** — new component in `conduit/`; receives Sigil mesh config; establishes mTLS tunnels to peer clusters
- **VerdictSync extension** — must learn Conduit peer IPs as additional VERDICT_MAP entries alongside pod IPs
- **Sigil Conduit registry** — Sigil must track which Conduit endpoints represent which external services; push updates to connected kprobe agents

### Risk items for Phase 4:

| Risk | Detail |
|---|---|
| **VERDICT_MAP capacity** | Currently 4096. Phase 4 adds Conduit external IPs. If cluster has many peer clusters × many services, capacity may need to increase. Audit the math before Phase 4 coding starts. |
| **AD-4 (SYN-only enforcement) + Conduit TCP sessions** | Conduit opens long-lived mTLS tunnels. If Conduit re-uses IP addresses (e.g., ClusterIP DNAT), new tunnel connections may use the same src/dst as an old one, and the SYN-only guard means a newly denied connection could slip through if ACK is set due to OS TCP state. Needs analysis. |
| **Two-port Sigil (8443/8444) and Conduit client** | The Go Conduit client will need to implement the same Bootstrap→mTLS upgrade pattern as kprobe. The plaintext port 8444 must remain open. |
| **Policy reload pointer race in Sigil** | Flagged in Phase 2 AD-7 (deferred). Phase 3 Test 3.D passed without triggering it, but live reload under load could still hit it. Consider adding `sync.RWMutex` before Phase 4 adds Conduit as another concurrent policy consumer. |
| **Cluster restart loses active policy** | After a Docker Desktop restart, Sigil re-reads the ConfigMap policy from disk, but kprobe connects fresh and Sigil pushes the policy it has in memory at connect time. If the ConfigMap was not updated after the last POST /api/v1/config, the initial push will reflect stale policy. Not a code bug, but an operational procedure gap. |
