# MeshLite — Phase 4 Outcome Report
## Conduit: Cross-Cluster Gateway

---

## Header

| Field | Value |
|---|---|
| **Date** | April 11, 2026 |
| **Host OS** | Windows 11 + WSL2 (Ubuntu 24.04) |
| **Cluster 1** | `kind-meshlite-dev` — Kubernetes `v1.29.2` |
| **Cluster 2** | `kind-meshlite-dev-2` — Kubernetes `v1.35.0` |
| **Sigil image** | `meshlite/sigil:phase4` |
| **Conduit image** | `meshlite/conduit:phase4` |
| **Rust crates verified** | `meshlite-tls`, `kprobe-userspace`, `conduit` |
| **Commit** | Working tree (not committed in this session) |

---

## Executive Summary

**Phase 4's core goal PASSES.** A workload in Cluster 1 now reaches a workload in Cluster 2 through a dedicated Conduit Egress → Conduit Ingress path protected by Sigil-issued mTLS credentials and enforced by policy at the cluster boundary. The live verification command:

```bash
kubectl --context kind-meshlite-dev exec -n meshlite-test deploy/service-alpha -- \
  wget -qO- --timeout=20 --header="Host: service-beta" http://<conduit-egress-clusterip>:9090/
```

returned:

```text
service-beta OK
```

A deny-path test using `Host: service-gamma` returned **HTTP 403 Forbidden**, and the Egress log recorded `DENY -> service-gamma`. Same-cluster allow/deny behavior from Phase 3 still works with Conduit deployed. The remaining close-out checks also succeeded: a fake/self-signed client cert was rejected at the mTLS boundary, measured p99 latency was `8.622ms` vs `1.471ms` direct (`+7.151ms` overhead, accepted for kind), and traffic resumed about 7 seconds after deleting the live Ingress pod.

> **Design note:** The initial approach proposed gRPC `EnrollCluster` plus intermediate CAs. The implemented Phase 4 path uses a simpler, verified design: **REST `POST /api/v1/enroll-cluster` on Sigil HTTP `:8080` plus Sigil-issued leaf certs rooted in the shared MeshLite root CA**. This met the phase goal with less complexity and no proto regeneration.

---

## What Was Built

| Component | Description | File(s) |
|---|---|---|
| **Shared TLS crate** | Extracted reusable `CertStore` and `PolicyCache` into a new crate used by both kprobe and conduit | `crates/meshlite-tls/` |
| **Kprobe compatibility shims** | `kprobe-userspace` now re-exports the shared TLS/cache types from `meshlite-tls` | `kprobe/kprobe-userspace/src/cert_store.rs`, `policy_cache.rs` |
| **Sigil cluster enrollment API** | New REST endpoint `POST /api/v1/enroll-cluster` issues Conduit certs and returns root CA PEM | `sigil/cmd/server/main.go` |
| **Policy JSON support** | Added JSON tags on `policy.AllowRule` so Conduit can poll `/api/v1/policy` reliably | `sigil/internal/policy/engine.go` |
| **Conduit binary** | Rust binary with `egress` and `ingress` modes, policy polling, TLS setup, and HTTP proxying | `conduit/src/main.rs`, `cluster_client.rs`, `egress.rs`, `ingress.rs`, `tls_config.rs` |
| **Conduit container build** | Stable-Rust Docker image for the Conduit runtime | `conduit/Dockerfile` |
| **Conduit Helm chart** | Deployment + Service + RBAC for `mode=egress` and `mode=ingress` installs | `charts/conduit/` |
| **Cluster-2 kind config** | Second kind cluster config with separate pod/service CIDRs and ingress NodePort mapping | `hack/kind-config-cluster-2.yaml` |
| **Cross-cluster policy fixture** | Mesh config used to validate cross-cluster allow/deny flows | `tests/fixtures/mesh-cross-cluster.yaml`, `mesh-cross-cluster-2.yaml` |
| **Shared-root CA import path** | Optional Helm init container to copy `root.crt` and `root.key` from a Secret into Sigil's PVC before startup | `charts/sigil/templates/deployment.yaml` |

---

## Verification of Code Changes

### Rust unit tests

| Target | Command | Result |
|---|---|---|
| `meshlite-tls` | `cargo test` | ✅ `10 passed; 0 failed` |
| `kprobe-userspace` | `cargo test --package kprobe-userspace` | ✅ `11 passed; 0 failed` |
| `conduit` | `cargo test` | ✅ `3 passed; 0 failed` |

### Go build verification

| Target | Command | Result |
|---|---|---|
| `sigil` | `go -C /mnt/d/Projects/MeshLite/sigil build ./...` | ✅ clean build |

---

## Live Execution Results

### Cluster provisioning and shared CA

- `kind create cluster --config hack/kind-config-cluster-2.yaml --wait 120s` → **success**
- `kubectl --context kind-meshlite-dev-2 get nodes` → **3/3 Ready**
- Cluster 2 Sigil log shows:

```text
Sigil CA initialized — loaded existing root CA from disk
```

This confirms the second cluster used the same MeshLite root CA instead of generating a new one.

### Conduit startup

**Egress log evidence:**

```text
[conduit] enrollment OK — cert received
[egress] listening on 0.0.0.0:9090, peer=172.18.0.6:30443
```

**Ingress log evidence:**

```text
[conduit] enrollment OK — cert received
[ingress] listening on 0.0.0.0:443 (mTLS, cluster=cluster-2)
```

### Cross-cluster request path

**Allow path**

Command run:

```bash
kubectl --context kind-meshlite-dev exec -n meshlite-test deploy/service-alpha -- \
  wget -qO- --timeout=20 --header="Host: service-beta" http://10.96.192.102:9090/
```

Result:

```text
service-beta OK
```

Relevant logs:

```text
[egress] ALLOW -> service-beta
[ingress] routing Host:service-beta -> service-beta.meshlite-test.svc.cluster.local:8080
```

**Deny path**

Command run:

```bash
kubectl --context kind-meshlite-dev exec -n meshlite-test deploy/service-alpha -- \
  wget -S -O- --timeout=15 --header="Host: service-gamma" http://10.96.192.102:9090/
```

Result:

```text
HTTP/1.1 403 Forbidden
```

Relevant log:

```text
[egress] DENY -> service-gamma
```

### Negative TLS, latency, and restart checks

**4.E — Fake/self-signed cert rejection**

Command run from a kind node on the shared Docker network:

```bash
docker exec meshlite-dev-control-plane sh -lc \
  "openssl ecparam -name prime256v1 -genkey -noout -out /tmp/fake2.key; \
   openssl req -new -x509 -key /tmp/fake2.key -out /tmp/fake2.crt -days 1 -subj '/CN=meshlite-cluster-evil-2'; \
   echo | openssl s_client -connect 172.18.0.6:30443 -servername localhost \
     -cert /tmp/fake2.crt -key /tmp/fake2.key -quiet"
```

Result:

```text
... sslv3 alert certificate unknown ...
```

Ingress log evidence from the same window:

```text
[ingress] connection error: received fatal alert: UnknownCA
[ingress] connection error: invalid peer certificate: Other(OtherError(CaUsedAsEndEntity))
```

No `routing Host:` line appeared for the forged connection, so no bytes were forwarded.

**4.F — Latency benchmark**

Measured from `meshlite-dev-control-plane` with 100 direct NodePort requests and 100 Conduit requests:

- direct baseline: p50 `1.067ms`, p99 `1.471ms`, max `1.494ms`
- Conduit path: p50 `7.050ms`, p99 `8.622ms`, max `9.287ms`
- p99 overhead: `+7.151ms`

This is above the original `<5ms` target but still inside the runbook's documented acceptable `5–10ms` range for single-host kind testing.

**4.G — Ingress restart resilience**

The active Ingress pod `conduit-ingress-conduit-cd8474c68-ph5jn` was deleted at `06:38:12Z`. The replacement pod started at `06:38:17Z`, and routing resumed by `06:38:19Z`:

```text
[conduit] enrollment OK — cert received
[ingress] listening on 0.0.0.0:443 (mTLS, cluster=cluster-2)
[ingress] routing Host:service-beta -> service-beta.meshlite-test.svc.cluster.local:8080
```

A post-restart request again returned `service-beta OK`, so cross-cluster enforcement resumed well within 30 seconds.

### Same-cluster regression check (Phase 3 still intact)

Commands run:

```bash
# allow direction
kubectl --context kind-meshlite-dev exec -n meshlite-test deploy/service-alpha -- \
  wget -qO- --timeout=10 http://10.96.112.235:8080/

# deny direction
kubectl --context kind-meshlite-dev exec -n meshlite-test deploy/service-beta -- \
  wget -qO- --timeout=5 http://10.96.169.133:8080/
```

Results:

- ✅ `service-beta OK`
- ✅ reverse direction timed out (`exit 1`)

This confirms Phase 3 same-cluster enforcement still behaves correctly while Conduit is running.

---

## Exit Criteria Status

| ID | Criterion | Status | Evidence |
|---|---|:---:|---|
| **4.A** | Cross-cluster network path works before Conduit | ✅ | From Cluster 1 pod to `172.18.0.6:30443` before ingress deploy: `Connection refused` (reachable, not `no route to host`) |
| **4.B** | Both Conduit sides enroll and start successfully | ✅ | Egress and Ingress logs show `enrollment OK — cert received` and active listeners |
| **4.C** | `service-alpha` reaches `service-beta` in Cluster 2 | ✅ | `service-beta OK` via Egress ClusterIP + `Host: service-beta` |
| **4.D** | Unauthorized cross-cluster call is denied at Egress | ✅ | `HTTP/1.1 403 Forbidden` for `Host: service-gamma`; Egress log `DENY -> service-gamma` |
| **4.E** | Forged/self-signed cluster cert is rejected | ✅ | `openssl s_client` with a forged EC cert failed with `sslv3 alert certificate unknown`; Ingress logged `UnknownCA` / `CaUsedAsEndEntity`, and no `routing Host:` line appeared |
| **4.F** | p99 latency overhead under 5ms | ✅* | Direct baseline p99 `1.471ms` vs Conduit p99 `8.622ms` (`+7.151ms`); above the ideal target but within the runbook's accepted `5–10ms` kind variance |
| **4.G** | Ingress restart recovery / resume behavior | ✅ | Ingress pod deleted at `06:38:12Z`; replacement started at `06:38:17Z` and resumed routing by `06:38:19Z`; post-restart request returned `service-beta OK` |
| **4.H** | Phase 3 same-cluster allow/deny still pass with Conduit present | ✅ | `service-beta OK` in allow direction; reverse direction timeout still observed |

---

## Issues Encountered and Fixes

| # | Issue | Root cause | Resolution |
|---|---|---|---|
| **I-1** | `kprobe-userspace` shim files had duplicate type definitions after extraction | Partial replacement left old `CertStore` / `PolicyCache` code below the new `pub use` lines | Replaced both files with clean re-export shims only |
| **I-2** | Conduit panicked at startup about rustls `CryptoProvider` | rustls 0.23 required explicit provider installation in this build setup | Added `rustls::crypto::ring::default_provider().install_default()` in `main.rs` |
| **I-3** | Ingress/Egress bind failed with `failed to lookup address information` | Tokio bind target `":443"` / `":9090"` was not normalized to an explicit host | Added `normalize_listen_addr()` → `0.0.0.0:<port>` |
| **I-4** | TLS handshake failed with `certificate not valid for name ...` | Egress used the wrong SNI name and initial Conduit certs lacked DNS SANs | Sigil enrollment switched to `IssueWithDNS(...)` and Egress now uses `localhost` SNI, which Sigil includes as a DNS SAN |
| **I-5** | Conduit TLS loader rejected EC private keys | `IssueWithDNS` emits an EC private key PEM, while the loader only accepted PKCS#8 | `tls_config.rs` now accepts both PKCS#8 and EC PEM key formats |
| **I-6** | Cluster 2 Sigil initially failed to load the imported root CA | PowerShell file export/import mangled the PEM content | Recreated the secret directly from live pod output and added `existingRootCASecret` import logic in the chart |
| **I-7** | Cluster 1 Egress could not reliably resolve `sigil.meshlite-system.svc.cluster.local` | Current kprobe enforcement on Cluster 1 interferes with in-pod DNS lookups | Deployed Egress with the cluster-1 Sigil **ClusterIP** instead of the DNS name |
| **I-8** | Conduit needed policy access to Sigil itself for enrollment and polling | The Phase 4 policy fixture allowed service traffic but not `conduit -> sigil` | Updated `mesh-cross-cluster*.yaml` to allow `conduit` / `conduit-cluster-*` to reach `sigil` |

---

## Readiness Verdict

### Functional verdict: **PASS**

The central Phase 4 claim is now demonstrated:

- a request originating in Cluster 1 can be forwarded through Conduit Egress,
- protected by Sigil-issued mTLS at the cluster boundary,
- verified by Conduit Ingress in Cluster 2,
- and delivered to the target service with no application code change.

### Close-out status

All Phase 4 execution-depth tests have now been exercised:

1. **4.E** fake-cert negative test — **pass** (`UnknownCA` / `certificate unknown`)
2. **4.F** latency benchmark — **accepted** in kind with p99 overhead `+7.151ms`
3. **4.G** Ingress restart resilience — **pass**, routing resumed within about 7 seconds of pod deletion

The only caveat is that the latency value comes from a single-host kind environment and should be re-measured on a less artificial network if Phase 5 depends on a stricter SLO.

---

## Recommendation

**Proceed to Phase 5.** Phase 4 is now exercised across functional, negative, latency, and restart-recovery checks. Carry forward the measured kind latency (`p99 ≈ 8.622ms`, `+7.151ms` over direct) as a lab baseline rather than a production limit.
