# MeshLite — Phase 5 Approach

## Trace + meshctl: Observability and CLI

---

## 1. Goal

Prove that MeshLite’s enforcement path is now **observable and operable** end to end: allowed, denied, and cross-cluster requests appear in Trace within seconds, and operators can inspect and change live policy from the terminal using `meshctl` without reading raw pod logs.

---

## 2. Scope

### In scope

| Item | Description |
| --- | --- |
| Telemetry emission in `kprobe` | Add best-effort telemetry emission from `kprobe-userspace` for same-cluster allow / deny / TLS-failure events, including source, destination, cluster, verdict, and latency |
| Telemetry emission in `conduit` | Add boundary telemetry for cross-cluster allow / deny / handshake outcomes, classified with `leg = cross_cluster` |
| Trace backend (`trace/backend/`) | New Go service that accepts telemetry over HTTP/JSON, aggregates in memory, exposes Prometheus `/metrics`, and serves JSON APIs for the UI |
| Trace frontend (`trace/frontend/`) | React + TypeScript + Vite dashboard with a **Rancher-inspired** operator layout: left navigation, summary cards, traffic table, service graph, and recent denial / TLS-failure events |
| Trace deployment (`charts/trace/`) | Helm chart to deploy the backend and serve the built frontend inside the cluster |
| Private Trace access mode | Support internal/private-domain deployment of Trace for the MVP **without app-level auth**, using cluster ingress/load balancer + network restrictions as the access boundary |
| `meshctl` CLI (`meshctl/`) | Implement `apply`, `status`, `verify`, `logs`, `rotate`, and `version` commands using the existing Sigil / Trace HTTP APIs |
| Phase 5 live verification | Run the Trace + CLI tests against the already-working Phase 4 environment and record actual measured results |

### NOT in scope this phase

- A production Prometheus / Grafana stack (Trace only needs to expose `/metrics` cleanly)
- Long-term telemetry persistence, retention, or a time-series database
- Full application-level authentication, multi-user RBAC, or SSO for the dashboard
- Public internet exposure of Trace without auth
- Distributed tracing / spans / OpenTelemetry export
- Alerting, notifications, or SLO burn-rate logic
- Mobile/responsive dashboard polish beyond a usable desktop UI
- Reworking the security model from Phases 3–4; this phase observes and operates the existing design
- The final human-friendly architecture explainer is a **phase close-out deliverable**, not a Stage 1 coding task

---

## 3. Components

### 3.1 Telemetry record schema and emitters

A single lightweight telemetry shape will be used by both `kprobe` and `conduit`:

```text
TelemetryRecord {
  source_service
  destination_service
  cluster_id
  leg                # intra_cluster | cross_cluster
  verdict            # allow | deny | tls_reject | error
  latency_ms
  tls_verified
  status_code?       # optional when known
  error_reason?
  timestamp
}
```

**Delivery model:**

- Non-blocking, buffered send from the request path
- Best-effort only: if Trace is unavailable or the buffer is full, the request still proceeds and the record may be dropped
- Transport for Phase 5 will be **HTTP/JSON to Trace** rather than introducing a new protobuf stream

This keeps observability out of the hot path and avoids changing the already-verified security contracts.

### 3.2 Trace backend (`trace/backend/`)

A lightweight Go server with these responsibilities:

1. `POST /api/v1/telemetry` — ingest telemetry records from `kprobe` and `conduit`
2. Aggregate counters / histograms in memory and expose:
   - `meshlite_requests_total{src,dst,leg,verdict}`
   - `meshlite_request_duration_ms_bucket{src,dst,leg,...}`
   - `meshlite_policy_denials_total{src,dst,leg}`
   - `meshlite_tls_failures_total{src,dst,reason}`
3. `GET /api/v1/topology` — current service graph nodes / edges for the UI
4. `GET /api/v1/events` — recent deny / TLS-failure event feed
5. `GET /api/v1/summary` — high-level cards for totals, denials, and latency
6. Serve the built React app as static files

For this phase, state may remain **in memory only**. A restart may clear the live graph history; that is acceptable for the lab proof.

### 3.3 Trace frontend (`trace/frontend/`)

The dashboard will use **React + TypeScript + Vite** with a **Rancher-inspired, operator-first layout**:

- **Left navigation + top summary bar** — familiar admin-console structure for clusters, traffic, and policy visibility
- **Overview graph** — service nodes and traffic edges, coloured by health / denial rate
- **Traffic summary table** — request totals, verdict mix, and latency percentiles for active service pairs
- **Recent events panel** — rolling feed of denials and TLS verification failures
- **Service detail drawer / panel** — quick inspection of a selected service or edge without leaving the main view

Implementation preference:

- `React Flow` for the service map
- simple polling (2–5 seconds) against the backend JSON APIs
- Tailwind for fast styling and a neutral enterprise/admin feel similar to Rancher

A fast, readable operator UI is the goal — not animation-heavy visual polish or feature-for-feature Rancher parity.

### 3.4 `meshctl` CLI (`meshctl/`)

`meshctl` will be the operator surface on top of the APIs already exposed by Sigil and Trace.

| Command | Backing API | Purpose |
| --- | --- | --- |
| `meshctl apply -f mesh.yaml` | `POST /api/v1/config` on Sigil | Apply new policy / config |
| `meshctl status` | `GET /api/v1/certs`, `GET /api/v1/policy`, Trace summary | Show services, cert expiry, and current policy state |
| `meshctl verify --from X --to Y` | live policy snapshot from Sigil | Predict ALLOW / DENY for a specific service pair |
| `meshctl logs --service X` | Trace recent events API | Show recent telemetry involving a service |
| `meshctl rotate --service X` | Sigil cert API / rotation trigger path | Force or request cert rotation for a service |
| `meshctl version` | local build info | Print component versions |

The CLI will be intentionally thin: it wraps live control-plane and observability endpoints, not a separate config store.

### 3.5 Trace deployment and local workflow

`charts/trace/` will package the Trace backend and UI together as a single in-cluster deployment for this phase.

**Access model for the MVP:**

- **Local/dev:** `kubectl port-forward` remains the simplest path
- **Consumer/self-hosted cluster:** Trace may also be exposed on a **private/internal domain** (for example `https://trace.mesh.internal`) via an internal ingress or load balancer
- **Security boundary for no-auth mode:** network location, private DNS, VPN, security groups, or IP allowlists — **not** public unauthenticated internet exposure

The default operator workflow will be:

1. Deploy / upgrade Trace with Helm
2. Access it either by local port-forward or a private/internal domain
3. Generate same-cluster and cross-cluster traffic
4. Validate metrics, UI, and `meshctl` outputs against real traffic

---

## 4. Dependencies

All of the following must be true before Phase 5 coding begins:

| Dependency | Where verified |
| --- | --- |
| Phase 4 exit criteria are closed and pushed to `main` | Commit `702f82c` on April 11, 2026 |
| Same-cluster enforcement from Phase 3 still passes | Re-verified during Phase 4 close-out |
| Cross-cluster Conduit path is working | `service-alpha -> service-beta` through Conduit returned `service-beta OK` in Phase 4 |
| Sigil REST endpoints are live on `:8080` | `GET /api/v1/policy`, `GET /api/v1/certs`, `POST /api/v1/config`, `POST /api/v1/enroll-cluster` already exist |
| Two local kind clusters remain available for execution testing | `kind-meshlite-dev` and `kind-meshlite-dev-2` verified during Phase 4 |
| Go 1.22+, Node.js 20+, Helm, and kubectl are available | project baseline from `docs/timeline.md` |

---

## 5. Exit Criteria

All eight conditions must pass before Phase 5 closes.

| ID | Criterion | Test |
| --- | --- | --- |
| **5.A** | Every allowed same-cluster request produces a Trace metric within 5 seconds | Generate traffic from `service-alpha` to `service-beta`; verify `meshlite_requests_total` increments |
| **5.B** | Every denied request increments the denial counter and appears in the event feed | Trigger a known deny path; verify `meshlite_policy_denials_total` and `/api/v1/events` |
| **5.C** | `/metrics` is valid Prometheus exposition format | Run `promtool check metrics` against Trace output |
| **5.D** | The dashboard renders the live service graph with real nodes / edges | Open the UI and verify `service-alpha -> service-beta` appears correctly |
| **5.E** | Cross-cluster traffic appears with correct `leg = cross_cluster` classification | Send requests through Conduit and verify Trace metrics / topology include the cross-cluster edge |
| **5.F** | `meshctl apply` updates live policy and the new verdict is reflected within 10 seconds | Apply an updated `mesh.yaml`, then verify traffic behavior and Sigil policy output |
| **5.G** | `meshctl verify` predicts ALLOW / DENY correctly against the live policy | Run `meshctl verify` for one allowed pair and one denied pair and compare with real behavior |
| **5.H** | `meshctl status` shows live services, cert expiry times, and policy summary | Run `meshctl status` and verify it matches Sigil / Trace state |

---

## 6. Risk Items

| # | Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| **R-1** | Telemetry emission could block the hot path if the backend is slow or unavailable | Medium | High | Use buffered, non-blocking emitters; drop records on backpressure rather than delay traffic |
| **R-2** | `kprobe` may not always know an exact HTTP status code for low-level forwarded traffic | High | Medium | Make `status_code` optional; the must-have metrics are request totals, denials, TLS failures, and latency |
| **R-3** | Cluster-1 in-pod DNS lookups were previously flaky under current enforcement | Medium | Medium | Allow explicit Trace endpoint override via env / Helm values; use proven service IPs if DNS remains unstable |
| **R-4** | Both `conduit` sides could emit overlapping records for one cross-cluster request | Medium | Medium | Define one canonical aggregation rule for request totals (Egress owns request outcome; Ingress owns inbound TLS / routing errors) |
| **R-5** | Frontend setup may consume time if dependency choices are too broad | Medium | Low | Keep to Vite + React + Tailwind + React Flow only; avoid extra framework churn |
| **R-6** | `meshctl apply` could push invalid config and leave the operator unsure what happened | Medium | Medium | Surface Sigil validation errors directly and treat non-2xx responses as command failure |
| **R-7** | In-memory-only Trace storage means a restart clears graph history | Certain | Low | Accept for Phase 5; document clearly as a lab limitation, not a bug |
| **R-8** | No-auth Trace access could be deployed too openly and mistaken for a public-ready model | Medium | High | Limit the MVP access model to private/internal domains, internal load balancers, VPN, or IP allowlists only |

---

## 7. Architecture Decisions Inherited from Phase 4

These decisions are already locked in and should not be revisited in this phase.

| AD | Decision | Phase 5 implication |
| --- | --- | --- |
| AD-1 | Sigil’s REST API on `:8080` is the practical operator surface | `meshctl` should wrap REST endpoints instead of adding new control-plane protocols |
| AD-2 | Cross-cluster enforcement happens at Conduit Egress / Ingress | Trace must classify those records as `cross_cluster`, not invent a new path model |
| AD-3 | Kprobe remains the same-cluster enforcer; no sidecars | Same-cluster telemetry must come from the existing Kprobe userspace path |
| AD-4 | Security and routing are already proven; observability must not change verdict logic | Phase 5 code must be additive and low-risk to the working path |
| AD-5 | MVP Trace access may be no-auth only when it is private/internal and network-restricted | Document the consumer access model clearly; do not present public no-auth exposure as production-ready |
| AD-6 | The project’s final close-out also requires a human-readable architecture explainer | After Phase 5 verification, produce both the outcome report and the separate final architecture document |

---

## 8. What Success Looks Like

After Phase 5, the operator experience should look like this:

```bash
# apply or inspect policy from the terminal
meshctl status
meshctl verify --from service-alpha --to service-beta
meshctl verify --from service-beta --to service-alpha

# open the dashboard locally
kubectl -n meshlite-system port-forward svc/trace 3000:3000

# or in a consumer cluster, open the private/internal Trace URL
# https://trace.mesh.internal
```

Expected operator outcome:

- operators can open Trace either through local port-forward or an internal/private domain
- `meshctl status` shows the active services, cert expiry windows, and policy summary
- `meshctl verify --from service-alpha --to service-beta` prints **ALLOW**
- `meshctl verify --from service-beta --to service-alpha` prints **DENY**
- The Trace UI shows `service-alpha → service-beta` as a healthy edge
- A deny attempt appears in the recent events feed within a few seconds
- A cross-cluster request appears in the unified view with `leg = cross_cluster`

This closes the MeshLite story: **secure traffic enforcement is already proven, and now it is observable, explainable, and operable from one place.**
