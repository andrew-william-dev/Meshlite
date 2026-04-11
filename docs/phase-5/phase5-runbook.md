# MeshLite — Phase 5 Runbook

## Trace + meshctl: Observability and CLI

> **Written:** April 11, 2026  
> **Status:** Active — update in real time during Stage 3 and Stage 4  
> **Approach doc:** `docs/phase-5/phase5-approach.md`

---

## 1. Prerequisites

### Host machine requirements

| Requirement | Verified state |
| --- | --- |
| Windows 11 + WSL2 | Required for the current local workflow |
| Docker Desktop running | kind nodes and local image loads depend on it |
| At least 16 GB RAM | two kind clusters + Trace UI/backend + builds |
| Phase 4 environment still available | `kind-meshlite-dev` and `kind-meshlite-dev-2` must still be healthy |

### Required tools and exact versions

All commands below are intended for **WSL2** unless the comment says otherwise.

| Tool | Version | Verify command |
| --- | --- | --- |
| Go | `1.22+` | `go version` |
| Rust | stable `1.86+` and nightly already installed for kprobe work | `rustup show` |
| Node.js | `20+` | `node --version` |
| npm | `10+` | `npm --version` |
| Helm | `3.14+` | `helm version --short` |
| kind | `0.22+` | `kind version` |
| kubectl | `1.29+` | `kubectl version --client` |
| Docker | `24+` | `docker version --format '{{.Server.Version}}'` |
| `promtool` | any recent Prometheus build | `promtool --version` |
| `jq` | any | `jq --version` |

### What must already be working from previous phases

- `Sigil` is running in `meshlite-system` on cluster 1
- `Kprobe` DaemonSet still enforces same-cluster allow / deny correctly
- `Conduit Egress` and `Conduit Ingress` are still running and the cross-cluster smoke path is healthy
- The policy fixtures still exist at:
  - `tests/fixtures/mesh-basic.yaml`
  - `tests/fixtures/mesh-one-way.yaml`
  - `tests/fixtures/mesh-cross-cluster.yaml`
  - `tests/fixtures/mesh-cross-cluster-2.yaml`

Verify before any Phase 5 coding:

```bash
# WSL2
kubectl --context kind-meshlite-dev get pods -n meshlite-system
kubectl --context kind-meshlite-dev-2 get pods -n meshlite-system
```

**Expected output:** all Sigil / Kprobe / Conduit pods show `Running` or `Ready`.

**If not:** fix the failed Phase 4 component first; do not start Phase 5 on broken runtime state.

---

## 2. One-Time Machine Setup

### Step M.1 — Verify frontend toolchain

```bash
# WSL2
node --version
npm --version
```

**Expected output:** Node `v20.x` or later and npm `10.x` or later.

**If not:** install Node 20 LTS before continuing.

### Step M.2 — Verify Prometheus metric validation tool

```bash
# WSL2
promtool --version
```

**Expected output:** prints a Prometheus version string.

**If `promtool` is missing:** use the Docker fallback in Test `5.C`:

```bash
# WSL2
docker run --rm -i prom/prometheus promtool check metrics < /tmp/meshlite-metrics.txt
```

### Step M.3 — Confirm Phase 5 work locations exist

```bash
# WSL2
mkdir -p trace/backend trace/frontend charts/trace meshctl/cmd
find trace -maxdepth 2 -type d | sort
```

**Expected output:** shows `trace/backend` and `trace/frontend`.

**If not:** create the directories exactly as above; do not invent alternative paths.

---

## 3. Steps

Run these in order. Finish the verification for one step before moving to the next.

---

### Step 5.1 — Add best-effort telemetry emission to Kprobe and Conduit

**Goal:** Every same-cluster and cross-cluster request emits a non-blocking `TelemetryRecord` without changing the request verdict logic.

**Files to modify:**

| Component | File(s) |
| --- | --- |
| `kprobe-userspace` | `src/main.rs`, `src/metrics.rs` or equivalent new helper, request / decision logging path |
| `conduit` | `src/egress.rs`, `src/ingress.rs`, `src/main.rs`, optional new `src/telemetry.rs` |
| shared schema | `crates/meshlite-tls/src/lib.rs` only if a reusable record type is needed |

**Implementation rules:**

- Use a **buffered channel** and a background sender task
- Emit over **HTTP/JSON** to Trace, not gRPC, for this phase
- Never block traffic on telemetry delivery
- If Trace is down, log once and drop subsequent records until the next retry window
- Egress is the owner of cross-cluster request outcome counts; Ingress only reports TLS / routing failures

**Verification commands:**

```bash
# WSL2 — same-cluster code still compiles
cd /mnt/d/Projects/MeshLite/kprobe
cargo test --package kprobe-userspace

# WSL2 — conduit still compiles
cd /mnt/d/Projects/MeshLite/conduit
cargo test
```

**Expected output:** all Rust tests still pass.

**If not:** stop and fix the regression before moving on. Phase 5 must be additive, not destabilising.

---

### Step 5.2 — Build the Trace backend in Go

**Goal:** Create a lightweight backend that ingests telemetry, exposes `/metrics`, and serves JSON APIs for the UI.

**Files to create / modify:**

| Action | File |
| --- | --- |
| Create | `trace/backend/go.mod` |
| Create | `trace/backend/cmd/server/main.go` |
| Create | `trace/backend/internal/ingest/` |
| Create | `trace/backend/internal/metrics/` |
| Create | `trace/backend/internal/topology/` |
| Create | `trace/backend/internal/events/` |
| Optional | `trace/backend/internal/httpapi/` |

**Required HTTP surface:**

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/telemetry` | ingest one or more telemetry records |
| `GET` | `/api/v1/summary` | summary cards and totals |
| `GET` | `/api/v1/topology` | nodes / edges for the graph |
| `GET` | `/api/v1/events` | recent deny / TLS failure events |
| `GET` | `/healthz` | liveness probe |
| `GET` | `/metrics` | Prometheus exposition |

**Verification commands:**

```bash
# WSL2
cd /mnt/d/Projects/MeshLite/trace/backend
go test ./...
go build ./...
```

**Expected output:** no failing Go tests; backend builds cleanly.

**If not:** fix API or build issues here before touching the frontend.

---

### Step 5.3 — Build the Trace frontend with React + TypeScript + Vite

**Goal:** Render a usable **application-first** operator dashboard backed by the Trace JSON APIs.

**Files to create / modify:**

| Action | File |
| --- | --- |
| Create | `trace/frontend/package.json` |
| Create | `trace/frontend/tsconfig.json` |
| Create | `trace/frontend/vite.config.ts` |
| Create | `trace/frontend/src/main.tsx` |
| Create | `trace/frontend/src/App.tsx` |
| Create | `trace/frontend/src/components/ServiceGraph.tsx` |
| Create | `trace/frontend/src/components/TrafficSummary.tsx` |
| Create | `trace/frontend/src/components/EventFeed.tsx` |
| Create | `trace/frontend/src/lib/api.ts` |

**UI requirements:**

- Application-first layout with focused navigation, summary cards, and a clean enterprise/admin visual style
- Graph view shows services as nodes and traffic as edges
- Edge state distinguishes healthy traffic from denial-heavy flows
- Summary shows request totals and latency percentiles
- Event panel shows recent denies and TLS failures
- Poll the backend every 2–5 seconds; no WebSocket is required for the lab proof

**Verification commands:**

```bash
# WSL2
cd /mnt/d/Projects/MeshLite/trace/frontend
npm install
npm run build
```

**Expected output:** Vite build completes and produces `dist/`.

**If not:** fix the frontend dependency or TypeScript error before moving on.

---

### Step 5.4 — Package and deploy Trace with Helm

**Goal:** Run the backend and serve the built UI from the cluster.

**Files to create / modify:**

| Action | File |
| --- | --- |
| Create | `charts/trace/Chart.yaml` |
| Create | `charts/trace/values.yaml` |
| Create | `charts/trace/templates/deployment.yaml` |
| Create | `charts/trace/templates/service.yaml` |
| Optional | `charts/trace/templates/configmap.yaml` |
| Create | `trace/backend/Dockerfile` |

**Deployment expectations:**

- service name: `trace`
- namespace: `meshlite-system`
- port `3000`: UI + JSON API
- port `9090`: `/metrics`
- optional **Ingress/internal domain** support for no-auth MVP access, intended for private/VPN-restricted environments only
- env vars for emitter endpoints are configurable in Helm values

**Verification commands:**

```bash
# WSL2
helm lint /mnt/d/Projects/MeshLite/charts/trace
helm upgrade --install trace /mnt/d/Projects/MeshLite/charts/trace -n meshlite-system
kubectl --context kind-meshlite-dev get deploy,svc -n meshlite-system | grep trace
```

**Expected output:** `helm lint` passes and the `trace` Deployment becomes `Available`.

**If not:** inspect `kubectl describe deploy/trace -n meshlite-system` and pod logs before continuing.

---

### Step 5.5 — Implement `meshctl`

**Goal:** Add a thin CLI that wraps Sigil and Trace for day-to-day operator tasks.

**Files to create / modify:**

| Action | File |
| --- | --- |
| Create | `meshctl/go.mod` |
| Create | `meshctl/cmd/root.go` |
| Create | `meshctl/cmd/apply.go` |
| Create | `meshctl/cmd/status.go` |
| Create | `meshctl/cmd/verify.go` |
| Create | `meshctl/cmd/logs.go` |
| Create | `meshctl/cmd/rotate.go` |
| Create | `meshctl/cmd/version.go` |
| Optional | `meshctl/internal/client/` |

**Required commands:**

```text
meshctl --sigil-url http://127.0.0.1:8080 apply  -f tests/fixtures/mesh-one-way.yaml
meshctl --sigil-url http://127.0.0.1:8080 verify --from service-alpha --to service-beta
meshctl --sigil-url http://127.0.0.1:8080 --trace-url http://127.0.0.1:3000 status
meshctl --trace-url http://127.0.0.1:3000 logs --service service-alpha
meshctl --sigil-url http://127.0.0.1:8080 rotate --service service-alpha
meshctl version
```

**Sigil support change required:** if `rotate` does not already exist, add a REST endpoint such as `POST /api/v1/certs/{serviceID}/rotate` in `sigil/cmd/server/main.go` and test it before wiring the CLI.

**Verification commands:**

```bash
# WSL2
cd /mnt/d/Projects/MeshLite/meshctl
go test ./...
go build ./...
```

**Expected output:** CLI builds cleanly and each command exits non-zero on API failure.

**If not:** surface the real server error to stdout/stderr rather than hiding it.

---

### Step 5.6 — Expose the live services for execution testing

**Goal:** Expose Sigil and Trace either locally by port-forward or through a private/internal domain for the Stage 4 tests below.

```bash
# WSL2 — Terminal A
kubectl --context kind-meshlite-dev -n meshlite-system port-forward svc/sigil 8080:8080

# WSL2 — Terminal B
kubectl --context kind-meshlite-dev -n meshlite-system port-forward svc/trace 3000:3000 9090:9090
```

**Expected output:** both commands print `Forwarding from 127.0.0.1...` and stay attached.

**Alternative access path for a consumer cluster:** enable the chart's `ingress.enabled=true` and point it at a **private/internal DNS name** such as `trace.mesh.internal`. This remains a no-auth MVP access model and must stay behind VPN, private networking, or IP allowlists.

**If not:** ensure the services exist and the ports in the Helm chart match the runbook.

---

## 4. Tests

Each test maps directly to one Phase 5 exit criterion.

---

### Test 5.A — Telemetry for allowed same-cluster traffic

**Criterion:** Every allowed same-cluster request appears in Trace metrics within 5 seconds.

```bash
# WSL2 — generate 20 allowed requests
kubectl --context kind-meshlite-dev exec -n meshlite-test deploy/service-alpha -- \
  sh -c 'i=0; while [ $i -lt 20 ]; do i=$((i+1)); wget -qO- --timeout=5 http://service-beta:8080/ > /dev/null; done'

# WSL2 — inspect metrics
curl -s http://127.0.0.1:9090/metrics | grep 'meshlite_requests_total{src="service-alpha",dst="service-beta",leg="intra_cluster",verdict="allow"}'
```

**Expected output:** counter value is at least `20`.

**Pass condition:** the metric appears within 5 seconds of the traffic run.

---

### Test 5.B — Denials appear in metrics and recent events

**Criterion:** Every denied request increments the denial counter and appears in the event feed.

```bash
# WSL2 — generate 10 denied requests
kubectl --context kind-meshlite-dev exec -n meshlite-test deploy/service-beta -- \
  sh -c 'i=0; while [ $i -lt 10 ]; do i=$((i+1)); wget -qO- --timeout=5 http://service-alpha:8080/ || true; done'

# WSL2 — inspect denial counter
curl -s http://127.0.0.1:9090/metrics | grep 'meshlite_policy_denials_total{src="service-beta",dst="service-alpha",leg="intra_cluster"}'

# WSL2 — inspect recent events
curl -s http://127.0.0.1:3000/api/v1/events | jq '.'
```

**Expected output:** denial counter increases and at least one recent event mentions `service-beta` -> `service-alpha`.

**Pass condition:** both the metric and the event feed reflect the denial.

---

### Test 5.C — `/metrics` validates as Prometheus format

**Criterion:** Trace exposes valid Prometheus text format.

```bash
# WSL2
curl -s http://127.0.0.1:9090/metrics > /tmp/meshlite-metrics.txt
promtool check metrics /tmp/meshlite-metrics.txt
```

**Fallback if `promtool` is not installed:**

```bash
# WSL2
docker run --rm -i prom/prometheus promtool check metrics < /tmp/meshlite-metrics.txt
```

**Expected output:** `SUCCESS: ... valid Prometheus text format`.

**Pass condition:** validator exits `0`.

---

### Test 5.D — Dashboard service graph renders real traffic

**Criterion:** The UI shows live nodes and edges, not placeholder data.

```bash
# PowerShell or any browser-capable environment
# Open one of these URLs manually:
http://127.0.0.1:3000
# or the private/internal Trace domain if ingress is enabled
# https://trace.mesh.internal
```

**Expected UI state:**

- `service-alpha` and `service-beta` appear as nodes
- an allow edge exists from `service-alpha` to `service-beta`
- the event panel shows recent denies if Test `5.B` was run
- no hard-coded demo content is visible

**Pass condition:** the graph reflects real cluster traffic data from the backend.

---

### Test 5.E — Cross-cluster traffic is classified correctly

**Criterion:** Cross-cluster requests appear with `leg = cross_cluster`.

First discover the current Conduit Egress ClusterIP if needed:

```bash
# WSL2
kubectl --context kind-meshlite-dev get svc -n meshlite-system conduit-egress-conduit -o jsonpath='{.spec.clusterIP}'
```

Then generate traffic through Egress:

```bash
# WSL2 — replace <EGRESS_IP> with the output above
kubectl --context kind-meshlite-dev exec -n meshlite-test deploy/service-alpha -- \
  sh -c 'i=0; while [ $i -lt 10 ]; do i=$((i+1)); wget -qO- --timeout=20 --header=Host:service-beta http://<EGRESS_IP>:9090/ > /dev/null; done'

# WSL2 — confirm Trace classification
curl -s http://127.0.0.1:9090/metrics | grep 'leg="cross_cluster"'
curl -s http://127.0.0.1:3000/api/v1/topology | jq '.'
```

**Expected output:** a metric and topology edge exist for `service-alpha -> service-beta` with `leg="cross_cluster"`.

**Pass condition:** the cross-cluster edge is visible and not mislabeled as `intra_cluster`.

---

### Test 5.F — `meshctl apply` updates live policy

**Criterion:** Applying config changes the live policy within 10 seconds.

```bash
# WSL2 — switch to a known restrictive config
cd /mnt/d/Projects/MeshLite/meshctl
go run ./cmd -- --sigil-url http://127.0.0.1:8080 apply -f ../tests/fixtures/mesh-one-way.yaml

# WSL2 — read live policy back from Sigil
curl -s http://127.0.0.1:8080/api/v1/policy | jq '.'
```

**Expected output:** the policy snapshot shows only the intended allow rule(s).

**Pass condition:** the live policy output changes within 10 seconds of the apply command.

> After the check, restore the broader test fixture if the next test expects it.

---

### Test 5.G — `meshctl verify` matches live ALLOW / DENY behavior

**Criterion:** `meshctl verify` predicts policy correctly for real service pairs.

```bash
# WSL2
cd /mnt/d/Projects/MeshLite/meshctl
go run ./cmd -- --sigil-url http://127.0.0.1:8080 verify --from service-alpha --to service-beta
go run ./cmd -- --sigil-url http://127.0.0.1:8080 verify --from service-beta --to service-alpha
```

**Expected output:**

- first command prints `ALLOW`
- second command prints `DENY`

**Pass condition:** CLI prediction matches actual runtime behavior already observed in pod traffic.

---

### Test 5.H — `meshctl status` shows services, certs, and policy summary

**Criterion:** Operators can inspect live state from one command.

```bash
# WSL2
cd /mnt/d/Projects/MeshLite/meshctl
go run ./cmd -- --sigil-url http://127.0.0.1:8080 --trace-url http://127.0.0.1:3000 status
```

**Expected output:**

- active service list
- cert expiry information
- current policy summary
- recent totals or health indicators from Trace

**Pass condition:** the command exits `0` and the output matches current Sigil / Trace state.

---

## 5. Exit Criteria Checklist

- [ ] **5.A** allowed same-cluster requests show up in Trace within 5 seconds — verified by [Test 5.A](#test-5a--telemetry-for-allowed-same-cluster-traffic)
- [ ] **5.B** denied requests increment counters and event feed — verified by [Test 5.B](#test-5b--denials-appear-in-metrics-and-recent-events)
- [ ] **5.C** `/metrics` passes Prometheus validation — verified by [Test 5.C](#test-5c--metrics-validates-as-prometheus-format)
- [ ] **5.D** dashboard graph renders real traffic — verified by [Test 5.D](#test-5d--dashboard-service-graph-renders-real-traffic)
- [ ] **5.E** cross-cluster metrics are correctly labeled — verified by [Test 5.E](#test-5e--cross-cluster-traffic-is-classified-correctly)
- [ ] **5.F** `meshctl apply` updates live policy within 10 seconds — verified by [Test 5.F](#test-5f--meshctl-apply-updates-live-policy)
- [ ] **5.G** `meshctl verify` predicts ALLOW / DENY correctly — verified by [Test 5.G](#test-5g--meshctl-verify-matches-live-allow--deny-behavior)
- [ ] **5.H** `meshctl status` shows live services, cert expiry, and policy summary — verified by [Test 5.H](#test-5h--meshctl-status-shows-services-certs-and-policy-summary)

---

## 6. Teardown

When Phase 5 testing is complete and you want to remove only the new observability layer:

```bash
# WSL2
helm uninstall trace -n meshlite-system

# WSL2 — optional: remove any local test output
rm -f /tmp/meshlite-metrics.txt
```

If you want to stop the entire lab, use the existing project teardown script:

```bash
# WSL2
cd /mnt/d/Projects/MeshLite
./hack/teardown.sh
```

---

## 7. Troubleshooting

| Symptom | Root cause | Resolution |
| --- | --- | --- |
| `meshctl` says `connection refused` | Sigil or Trace port-forward is not running, or the URL flag is wrong | Restart the correct `kubectl port-forward` and re-run the command with `--sigil-url` / `--trace-url` |
| `/metrics` is reachable but counters stay at zero | No traffic was generated, or telemetry env vars were not wired into Kprobe / Conduit | Generate real requests first; then inspect pod env and logs for the Trace endpoint configuration |
| Trace UI loads but shows an empty graph | Frontend can load, but `/api/v1/topology` is empty or the frontend base URL is wrong | Check browser dev tools, then `curl http://127.0.0.1:3000/api/v1/topology` directly |
| Same cross-cluster request appears twice in totals | Both Egress and Ingress are incrementing the same success counter | Keep Egress as the request owner; limit Ingress to TLS / inbound routing error records |
| Conduit or Kprobe logs spam telemetry errors | The sender is retrying too aggressively when Trace is unavailable | Add backoff and rate-limit repeated error logs |
| Cluster-1 pods fail to resolve the Trace or Sigil DNS name | Known runtime caveat from Phase 4 under current enforcement | Use the proven service `ClusterIP` override in Helm values instead of DNS |
| `promtool` is missing on the machine | Prometheus CLI is not installed locally | Use the Docker fallback command from Test `5.C` |
| `npm run build` fails on a fresh machine | Node version too old or dependencies did not install cleanly | Confirm Node 20+, remove `node_modules`, and reinstall with `npm install` |

---

## 8. Notes for the Phase 5 Outcome Report

When Stage 4 finishes, record all of the following in `docs/phase-5/phase5-outcome-report.md`:

- measured counter values for allowed, denied, and cross-cluster tests
- whether `promtool` passed directly or via Docker fallback
- screenshots or concise notes describing the graph and event feed state
- any gap between planned `meshctl` commands and the final implemented API surface
- final readiness verdict for the **full MeshLite system**

Also prepare the separate final architecture document requested by the user, focused on **how the whole system works conceptually**, not code flow.
