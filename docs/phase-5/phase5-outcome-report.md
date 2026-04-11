# MeshLite — Phase 5 Outcome Report
## Trace + `meshctl`: Observability and CLI

---

## Header

| Field | Value |
|---|---|
| **Date** | April 11, 2026 |
| **Host OS** | Windows 11 + WSL2 |
| **Cluster 1** | `kind-meshlite-dev` |
| **Cluster 2** | `kind-meshlite-dev-2` |
| **Sigil endpoint** | `http://127.0.0.1:8080` (`/healthz` returned `{"status":"ok"}`) |
| **Trace endpoint** | `http://127.0.0.1:3000` (`/healthz` returned `{"status":"ok"}`) |
| **Trace metrics** | `http://127.0.0.1:9090/metrics` |
| **Phase focus** | Application-first operator UI, private/internal no-auth access model, and `meshctl` MVP |
| **Commit state at report time** | Working tree verified locally before close-out commit |

---

## Executive Summary

**Phase 5 PASSED for the MVP goal.** MeshLite now closes the operator loop: same-cluster and cross-cluster traffic is visible in Trace within seconds, denials appear in the event feed, and core control-plane tasks can be executed from `meshctl` instead of raw pod logs. Fresh live verification on April 11 showed `meshctl verify` returning **ALLOW** for `service-alpha -> service-beta` and **DENY** for `service-beta -> service-alpha`, `meshctl rotate` succeeding for `service-alpha`, the topology API returning **8 services / 10 edges**, and Prometheus validation returning `PROMTOOL_OK` for `/metrics`.

> **Product-positioning verdict:** the **Phase 5 MVP is ready for internal/private use and demos**, but the overall product is still **not an honest public-production `v1.0.0`**. The current no-auth Trace mode is acceptable only behind a private/internal access boundary.

---

## What Was Built

| Component | Description | Location |
|---|---|---|
| **Trace backend** | Ingests telemetry over HTTP/JSON, aggregates request stats in memory, exposes `/summary`, `/topology`, `/events`, `/metrics`, and `/healthz` | `trace/backend/` |
| **Trace frontend** | React + TypeScript + Vite dashboard with an **application-first** operator layout: sidebar, summary cards, topology graph, traffic table, and event feed | `trace/frontend/` |
| **Trace Helm chart** | Deploys Trace in-cluster and supports port-forward or private/internal ingress usage | `charts/trace/` |
| **`meshctl` CLI** | Thin operator CLI for `apply`, `status`, `verify`, `logs`, `rotate`, and `version` | `meshctl/` |
| **Sigil rotate API** | Added manual rotation endpoint for `meshctl rotate` | `sigil/cmd/server/main.go` |
| **Conduit telemetry** | Emits best-effort cross-cluster allow/deny/error telemetry to Trace | `conduit/src/main.rs`, `conduit/src/egress.rs`, `conduit/src/ingress.rs`, `conduit/src/telemetry.rs` |
| **Kprobe telemetry** | Emits best-effort same-cluster allow/deny telemetry based on live perf events and pod identity resolution | `kprobe/kprobe-userspace/src/main.rs`, `kprobe/kprobe-userspace/src/telemetry.rs` |
| **Helm wiring for emitters** | Added `trace.addr` / `TRACE_URL` / `CONDUIT_TRACE_URL` configuration for Kprobe and Conduit | `charts/kprobe/`, `charts/conduit/` |
| **Policy fixtures for observability path** | Allows Conduit and Trace-related traffic needed for the Phase 5 MVP verification | `tests/fixtures/mesh-cross-cluster.yaml`, `tests/fixtures/mesh-cross-cluster-2.yaml` |
| **Phase close-out docs** | Approach, runbook, this outcome report, and the final human-friendly architecture explainer | `docs/phase-5/`, `docs/final-architecture-explainer.md` |

---

## Concepts Verified

### 1. Same-cluster traffic becomes visible without app changes

A request from `service-alpha` to `service-beta` was generated from inside the cluster, and Trace recorded it as an `intra_cluster` allow flow. This proves the observability path is truly additive to the existing enforcement design rather than requiring code changes in the workloads.

### 2. Denials are operator-visible, not hidden in kernel-only behavior

A reverse request from `service-beta` to `service-alpha` still timed out as expected, and Trace recorded the denial with `reason: policy_denied`. This matters because operators can now debug live policy outcomes from Trace or `meshctl logs` instead of depending only on low-level pod logs.

### 3. Cross-cluster requests are classified correctly

A request sent through `conduit-egress` to cluster 2 showed up with `leg="cross_cluster"` and `src="cluster/cluster-1"`. This verifies that Phase 4’s gateway path is now observable in the same unified operator view as same-cluster traffic.

### 4. The operator surface is now usable from both UI and CLI

`meshctl status`, `meshctl verify`, `meshctl apply`, `meshctl rotate`, and `meshctl logs` all succeeded against the live runtime. In parallel, the Trace topology and summary APIs returned real nodes, edges, totals, and event data that the frontend can render in the application-first dashboard.

### 5. Private/internal no-auth access is workable for the MVP

The design is now explicit: Trace may be opened by `kubectl port-forward` in local development or through a **private/internal domain** (for example an internal ingress or internal load balancer in EKS) for self-hosted/private deployments. This is acceptable for the MVP but is **not** equivalent to public, production-grade authentication and RBAC.

---

## Test Results

| Test ID | Exit Criterion | Result | Measured Value / Evidence |
|---|---|:---:|---|
| **5.A** | Allowed same-cluster request appears in Trace within 5 seconds | ✅ | `meshlite_requests_total{dst="service-beta",leg="intra_cluster",src="service-alpha",verdict="allow"} 1` |
| **5.B** | Denied request increments counters and appears in event feed | ✅ | `meshlite_policy_denials_total{dst="service-alpha",leg="intra_cluster",src="service-beta"} 2`; `meshctl logs --service service-beta` printed `reason: policy_denied` |
| **5.C** | `/metrics` is valid Prometheus exposition format | ✅ | Docker-based validation returned `PROMTOOL_OK` |
| **5.D** | Dashboard has real graph data to render live nodes and edges | ✅ | `GET /api/v1/topology` returned **8 nodes** and **10 edges**; `trace/frontend` also built successfully with Vite |
| **5.E** | Cross-cluster traffic is classified with `leg = cross_cluster` | ✅ | `meshlite_requests_total{dst="service-beta",leg="cross_cluster",src="cluster/cluster-1",verdict="allow"} 2` |
| **5.F** | `meshctl apply` updates live policy and reflects the result quickly | ✅ | `meshctl apply -f ..\tests\fixtures\mesh-cross-cluster.yaml` returned `✅ applied ...`; subsequent `meshctl status` showed the live policy summary (`allow rules: 4`) |
| **5.G** | `meshctl verify` predicts ALLOW / DENY correctly | ✅ | `✅ ALLOW — service-alpha -> service-beta`; `❌ DENY — service-beta -> service-alpha` |
| **5.H** | `meshctl status` shows certs, policy, and Trace totals | ✅ | `mTLS mode: enforce`, `default allow: false`, `services/certs: 12`, `trace requests: 3395039 (allowed=3395037 denied=2 tls_failures=0)` |

---

## Verification of Code Changes

| Target | Command | Result |
|---|---|---|
| `trace/backend` | `go test ./...` | ✅ pass |
| `meshctl` | `go test ./...` | ✅ pass |
| `conduit` | `cargo test` | ✅ `3 passed; 0 failed` |
| `trace/frontend` | `npm run build` | ✅ build succeeded |
| `charts/trace` | `helm lint .\charts\trace` | ✅ `1 chart(s) linted, 0 chart(s) failed` |

---

## Issues Encountered

| Issue | Root cause | Resolution |
|---|---|---|
| `sigil` host-side `go test` could not complete on Windows | `go-sqlite3` needs CGO and the local shell did not have `gcc` in `PATH` | Used Docker image build + live cluster rollout as the practical verification path for Sigil in this environment |
| `kprobe-userspace` host-side `cargo test` hit a platform-specific dependency issue | `aya-obj` depends on Unix-specific `std::os::fd`, which does not build in the current Windows host test path | Verified the kprobe changes through Docker image build and the live DaemonSet rollout instead |
| `kprobe` image build initially failed | The Docker build stages were missing `crates/meshlite-tls/`, which is now a shared path dependency | Updated `kprobe/Dockerfile` to copy the shared crate into both stages |
| `meshctl rotate` initially returned `404` | The local port-forward still pointed at a stale pre-rollout Sigil pod | Re-established the Sigil port-forward after rollout; rotation then succeeded |
| Same-cluster pod DNS was flaky during live testing | Current enforcement/runtime conditions in the lab occasionally break in-pod DNS lookups | Used service ClusterIPs for verification and added explicit `trace.addr` overrides in Helm values |
| Prometheus validation initially failed on naming / shell details | The first histogram name used abbreviated units, and later Windows shell piping introduced CRLF / piping quirks | Renamed the metric to `meshlite_request_duration_seconds` and validated with the corrected Docker-based `promtool` flow |
| Trace metrics contain noisy infrastructure traffic | Kprobe sees low-level lab traffic from `kindnet`, `trace`, and other infra actors | Accepted for the MVP; note this for future filtering / labeling hardening |

---

## Architecture Decisions Locked by Phase 5

1. **Trace stays operator-first and product-native.** The goal is a clear MeshLite admin console feel, not feature parity with any other platform.
2. **No-auth Trace access is only acceptable on a private/internal boundary.** Port-forward, VPN-only DNS, internal ingress, internal load balancers, and IP allowlists are valid MVP access patterns; public unauthenticated exposure is not.
3. **Telemetry transport remains best-effort HTTP/JSON.** Observability must never block the request path or change enforcement behavior.
4. **Trace aggregation may remain in-memory for the MVP.** Restart-safe retention and long-term storage are intentionally deferred.
5. **`meshctl` is a thin wrapper over existing Sigil and Trace APIs.** The CLI should not introduce a parallel control plane.
6. **Cross-cluster outcome ownership stays with Conduit Egress.** Ingress only reports boundary/TLS/routing failures; Egress owns the user-visible request outcome classification.

---

## Next Phase Readiness / Post-MVP Verdict

### Functional readiness: **READY for internal MVP use and follow-on hardening**

The MeshLite story is now coherent end-to-end:

- **Sigil** issues identity and policy,
- **Kprobe** enforces same-cluster decisions,
- **Conduit** protects cross-cluster traffic,
- **Trace** shows what is happening live,
- **`meshctl`** gives operators a fast CLI for applying and checking state.

### What still blocks a true public-production `v1.0.0`

- authentication / RBAC for shared or internet-facing Trace access
- telemetry persistence and retention beyond in-memory state
- noise reduction and stronger metric labeling for infra traffic
- broader packaging / hardening for real EKS private-ingress deployments
- cleaner host-platform verification for Windows-specific Rust / CGO paths

### Recommended next step

Treat the current result as **MVP complete / internal preview ready**, then move into production-hardening work rather than branding the project as already production-ready.
