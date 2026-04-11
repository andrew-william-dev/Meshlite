# MeshLite — Phase 4 Approach
## Conduit: Cross-Cluster Gateway

---

## 1. Goal

Prove that a service in Cluster 1 can make an HTTP request to a service in Cluster 2 with full mTLS enforced at the cluster boundary — both Conduit instances verify each other's cluster identity using the shared Sigil root CA, with zero application-level code changes.

---

## 2. Scope

### In scope

| Item | Description |
|---|---|
| `crates/meshlite-tls` | Shared Rust crate: extract `CertStore`, `PolicyCache`, `SigilClient` from `kprobe-userspace/src/` into a standalone workspace crate; both Kprobe and Conduit depend on it |
| Conduit binary | Single Rust binary (`conduit/src/`) with two modes: `--mode egress` and `--mode ingress` |
| Conduit Egress | Accepts intra-cluster traffic destined for another cluster; opens a cluster-boundary mTLS connection to Conduit Ingress |
| Conduit Ingress | Accepts cross-cluster mTLS from Conduit Egress; verifies peer cluster cert; forwards to destination pod inside Cluster 2 |
| Sigil cross-cluster federation | Extend Sigil to issue per-cluster intermediate CA certs and distribute the shared root CA to all clusters |
| Proto extensions | New proto messages for cluster enrollment and intermediate CA distribution |
| Helm chart `charts/conduit/` | Conduit deployment (Deployment, not DaemonSet); Ingress needs a NodePort Service |
| Two-cluster kind setup | `meshlite-dev` (existing) + `meshlite-dev-2` (new); Docker bridge network verified between them |
| Tests 4.A – 4.F | All six exit criteria from the timeline |

### NOT in scope this phase

- Trace telemetry (Phase 5)
- meshctl CLI (Phase 5)
- React UI (Phase 5)
- Cross-cluster policy **from** Cluster 2 to Cluster 1 (tested via 4.D but symmetric routing is not a requirement)
- Production-grade Conduit: no connection pooling, no health probes, no backpressure
- Any changes to the existing eBPF enforcement logic in Kprobe
- TLS session resumption optimisation (tracked as test 4.F; stub acceptable if within 5ms overhead)

---

## 3. Components

### 3.1 `crates/meshlite-tls` (new Rust workspace crate)

Extract the following from `kprobe/kprobe-userspace/src/` without behaviour change:

| Module | Source file | What moves |
|---|---|---|
| `cert_store` | `cert_store.rs` | `CertStore`, `build_tls_identity()` |
| `policy_cache` | `policy_cache.rs` | `PolicyCache`, `is_allowed()`, `default_allow()` |
| `sigil_client` | `sigil_client.rs` | `SigilClient`, full Bootstrap→UpgradingTLS→ConnectedTLS state machine |

`kprobe/Cargo.toml` updated to `path = "../crates/meshlite-tls"` dependency.  
Kprobe unit tests re-run after extraction — must still pass 21/21.

### 3.2 Conduit binary (`conduit/src/main.rs`)

Single binary, mode-switched at startup via `--mode [egress|ingress]`.

**Egress path:**
1. Starts SigilClient (uses `meshlite-tls`) → Bootstrap → ConnectedTLS
2. Receives `CertBundle` for the node's cluster boundary identity (service_id = `conduit-cluster-1`)
3. Listens on `:9090` (intra-cluster) for redirected cross-cluster TCP from Kprobe
4. For each connection: resolves destination cluster from DNS label (`*.cluster-2.meshlite.local`), checks PolicyCache, opens TLS 1.3 to Conduit Ingress using cluster boundary cert, proxies bytes
5. Logs: `[conduit-egress] cross-cluster: cluster-1/service-alpha → cluster-2/service-beta verdict=ALLOW`

**Ingress path:**
1. Starts SigilClient → Bootstrap → ConnectedTLS
2. Receives `CertBundle` for `conduit-cluster-2`
3. Listens on `:443` (external NodePort) for inbound mTLS from Conduit Egress
4. Verifies peer cert chain against Sigil root CA
5. Resolves destination service to pod IP inside Cluster 2 (via in-cluster DNS)
6. Opens plain TCP to destination (enforcement is Kprobe's job on the receiving node)
7. Logs: `[conduit-ingress] inbound: cluster-1 → cluster-2/service-beta verified=true`

### 3.3 Sigil cross-cluster federation (Go — `sigil/`)

New endpoint and two new proto messages:

**`ClusterEnroll` RPC:**
- Input: `ClusterHello { cluster_id, public_key_pem }`
- Output: `ClusterBundle { intermediate_ca_cert_pem, root_ca_pem, intermediate_key_pem }`
- A Conduit agent uses this instead of `Subscribe` — it enrolls the cluster, not a service

**Updated `SigilAgent` service:**
- Existing `Subscribe` RPC unchanged — Kprobe agents not affected
- New `EnrollCluster` RPC added

Sigil issues a fresh intermediate CA signed by the root CA for each enrolling cluster_id. Both Conduit Egress and Conduit Ingress hold their cluster's intermediate cert and present it during the cross-cluster TLS handshake. The peer verifies the chain: `leaf → intermediate → root`.

### 3.4 Helm chart `charts/conduit/`

```
charts/conduit/
├── Chart.yaml
├── values.yaml
└── templates/
    ├── deployment.yaml   # 1 replica, mode set by .Values.mode
    ├── service.yaml      # ClusterIP for egress; NodePort :443 for ingress
    └── rbac.yaml         # no eBPF, no host — minimal RBAC only
```

---

## 4. Dependencies

All of the following must be true before Phase 4 coding begins:

| Dependency | Where verified |
|---|---|
| Phase 3 all 6 exit criteria pass | `docs/phase-3/phase3-outcome-report.md` — confirmed April 11, 2026 |
| `meshlite-dev` kind cluster functional | Phase 3 exit; still running |
| `meshlite/kprobe:phase3` image loads in kind | Phase 3 — confirmed `sha256:a71f4f205f89` |
| `meshlite/sigil:phase3` image loads in kind | Phase 3 — confirmed `sha256:49d2a93a0ef0` |
| Sigil gRPC TLS operational on port 8443, Bootstrap on 8444 | Phase 3 AD-3 — both ports confirmed |
| `sigil.proto` compiles with `protoc` | Phase 3 I-1 — protoc pipeline working |
| Docker bridge network connects kind clusters on same host | To be verified in Step 1 of runbook |

---

## 5. Exit Criteria

All eight conditions must pass before Phase 4 closes.

| ID | Criterion | Test |
|---|---|---|
| **4.A** | A pod in `meshlite-dev` can reach a pod in `meshlite-dev-2` via plain HTTP (no MeshLite) — network path works before Conduit is involved | `kubectl exec` curl across clusters via NodePort |
| **4.B** | Conduit Egress and Conduit Ingress both log `ConnectedTLS` and receive their cluster boundary certs from Sigil on startup | `kubectl logs deploy/conduit-egress` + `deploy/conduit-ingress` |
| **4.C** | `service-alpha` (Cluster 1) sends a request to `service-beta.cluster-2.meshlite.local` and receives HTTP 200 | `kubectl exec` curl + exit 0 |
| **4.D** | An unauthorized cross-cluster call (no matching allow rule) is denied — connection refused at Conduit Egress before any bytes reach Cluster 2 | `kubectl exec` curl + exit 1; `[conduit-egress] verdict=DENY` in log |
| **4.E** | A forged cluster cert (self-signed, not from Sigil root CA) is rejected at Conduit Ingress — TLS handshake fails, no bytes forwarded | openssl s_client with fake cert; `TLS REJECTED` in Conduit Ingress log |
| **4.F** | Cross-cluster p99 latency overhead from Conduit is under 5ms versus direct NodePort baseline | `hey -n 5000` baseline vs Conduit; compare p99 |
| **4.G** | Conduit Ingress restart does not affect in-flight connections on the Egress side — Egress logs reconnect and resumes | `kubectl delete pod` on Ingress during `hey` run; no connection errors in Egress log after reconnect |
| **4.H** | Kprobe on `meshlite-dev` still enforces same-cluster policy correctly while Conduit is running — Phase 3 tests 3.B and 3.C still pass | Re-run Tests 3.B and 3.C with Conduit deployed |

---

## 6. Risk Items

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| **R-1** | `VERDICT_MAP` capacity at 4096 entries — adding cross-cluster Conduit IPs may fill the map on nodes with many services | Medium | High | Audit `VERDICT_MAP` size during 4.A; if close to limit, increase map size in eBPF source before writing Conduit IP registration code |
| **R-2** | TCP SYN-only enforcement (Phase 3 AD-4) means Conduit's long-lived tunnel TCP connections pass through uninspected after the first SYN | Medium | Medium | Conduit is a trusted MeshLite component — it enforces policy itself. Document as accepted; note this means a compromised Conduit binary is a trust boundary breach |
| **R-3** | Proto regeneration required — new `ClusterHello`, `ClusterBundle`, `EnrollCluster` fields will need `protoc` rerun. Same I-1 pattern from Phase 3 | High (certain) | Low | Run `protoc` immediately after proto change; verify generated Go files before writing any Go code that uses them |
| **R-4** | Sigil two-port design (AD-3 from Phase 3) — Conduit cluster enrollment needs the same Bootstrap→mTLS pattern as Kprobe; port 8444 must remain open for Conduit Ingress even on Cluster 2 | Medium | High | Verify Sigil port 8444 is accessible from `meshlite-dev-2` node IPs before writing Conduit SigilClient code; add `sigil.bootstrap_addr` to Conduit Helm values |
| **R-5** | Policy reload mutex deferred from Phase 2, not exercised by Phase 4 directly, but Conduit adds a concurrent reader of `PolicyCache` | Low | Medium | `PolicyCache` uses `Arc<Mutex<>>` — safe; the risk is a reload blocking the Conduit proxy loop. Add timeout on mutex acquire in Conduit; document if it blocks |
| **R-6** | Two kind clusters on the same Docker bridge — kind node IPs may overlap (both default to `172.18.0.0/16`) — Conduit Ingress NodePort may be unreachable from Cluster 1 pods | High | High | Use `kind create cluster --config` with explicit subnet overrides (`172.18.0.0/16` for cluster-1, `172.19.0.0/16` for cluster-2) before any networking tests |
| **R-7** | `meshlite-tls` crate extraction may require trait restructuring if `SigilClient` has hard dependencies on kprobe-specific types | Medium | Medium | Read `sigil_client.rs` in full before extracting; if it references `PodWatcher` types directly, those must be parameterised via a trait or moved into the shared crate too |

---

## 7. Architecture Decisions Inherited from Phase 3

These decisions are locked in from Phase 3 and constrain Phase 4 design. Do not revisit them.

| AD | Decision | Phase 4 implication |
|---|---|---|
| AD-1 | `VERDICT_MAP: HashMap<PacketKey, u8>` keyed by `(src_ip, dst_ip, proto)` | Conduit Egress IP must be registered in the map as ALLOW on port 9090 outbound from any pod |
| AD-2 | Cluster-wide PodWatcher in Kprobe | Conduit Ingress pod IP on Cluster 2 is automatically watched — no special registration needed |
| AD-3 | Sigil two-port: 8443 (mTLS) + 8444 (Bootstrap plain) | Conduit uses the same client pattern as Kprobe — Bootstrap on 8444, upgrade to 8443 |
| AD-4 | TCP SYN-only enforcement | Conduit proxy connections (long-lived) are trusted after the first SYN; Conduit enforces policy itself |
| AD-5 | `key_pem` delivered via `CertBundle.key_pem = 6` | Conduit's SigilClient uses same proto field; no new key delivery mechanism needed |

---

## 8. What Success Looks Like

After Phase 4, the following command works end to end:

```bash
# WSL2 — run from workspace root
kubectl --context kind-meshlite-dev \
  exec -it deploy/service-alpha -- \
  curl http://service-beta.cluster-2.meshlite.local/

# Output:
# service-beta OK

# Conduit Egress log:
# [conduit-egress] cross-cluster: cluster-1/service-alpha → cluster-2/service-beta
# [conduit-egress] cluster boundary mTLS: verified cluster-2 cert (chain OK)
# [conduit-egress] verdict=ALLOW latency_ms=<x>

# Conduit Ingress log:
# [conduit-ingress] inbound from cluster-1/service-alpha → service-beta
# [conduit-ingress] peer cert verified: cluster-1-intermediate → sigil-root ✅
```

This proves MeshLite enforces Zero Trust across cluster boundaries with no application code changes — the stated goal of the entire project.
