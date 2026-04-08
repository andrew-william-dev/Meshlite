# MeshLite — Phase 2 Runbook
## Sigil: Certificate Authority and Control Plane

> **Status:** Ready for execution
> **Approach:** `docs/phase-2/phase2-approach.md`
> **Last updated:** April 4, 2026

---

## Prerequisites

### Host machine requirements

| Requirement | Version | Check |
|---|---|---|
| WSL2 (Ubuntu 24.04) | any | `wsl --list --running` |
| Go | 1.22+ | `go version` |
| `protoc` | 25+ | `protoc --version` |
| `protoc-gen-go` | latest | `protoc-gen-go --version` |
| `protoc-gen-go-grpc` | latest | `which protoc-gen-go-grpc` |
| `grpcurl` | latest | `grpcurl --version` |
| Helm | 3.14+ | `helm version` |
| Docker (via Docker Desktop + WSL2) | 24+ | `docker version` |
| kind | 0.22+ | `kind version` |
| kubectl | 1.29+ | `kubectl version --client` |

### What must already be working (from Phase 1)

```bash
# WSL2 terminal — verify cluster is up
kubectl get nodes
# Expected: 3 nodes in Ready state (control-plane + 2 workers)

kubectl get pods -n meshlite-test
# Expected: service-alpha and service-beta in Running state
```

If the cluster is not running:
```bash
# WSL2 terminal
cd /path/to/meshlite
bash hack/dev-cluster.sh
kubectl apply -f tests/fixtures/test-services.yaml
```

---

## 1. One-Time Machine Setup

### 1.1 Install Go (if not installed)

```bash
# WSL2 terminal
go version
# If missing:
wget https://go.dev/dl/go1.22.0.linux-amd64.tar.gz
sudo rm -rf /usr/local/go
sudo tar -C /usr/local -xzf go1.22.0.linux-amd64.tar.gz
echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.bashrc
source ~/.bashrc
go version
# Expected: go version go1.22.x linux/amd64
```

### 1.2 Install protoc and plugins

```bash
# WSL2 terminal
# Install protoc
sudo apt-get update && sudo apt-get install -y protobuf-compiler
protoc --version
# Expected: libprotoc 3.x or 25.x

# Install Go plugins
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest

# Add Go bin to PATH if not already
echo 'export PATH=$PATH:$(go env GOPATH)/bin' >> ~/.bashrc
source ~/.bashrc

# Verify
protoc-gen-go --version
# Expected: protoc-gen-go v1.x.x
which protoc-gen-go-grpc
# Expected: a path (not empty)
```

### 1.3 Install grpcurl

```bash
# WSL2 terminal
go install github.com/fullstorydev/grpcurl/cmd/grpcurl@latest
grpcurl --version
# Expected: grpcurl v1.x.x  (or "grpcurl dev build <no version set>" if installed via go install — both are fine)
```

### 1.4 Install Helm

```bash
# WSL2 terminal
helm version
# If missing:
curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
helm version
# Expected: version.BuildInfo{Version:"v3.14.x", ...}
```

### 1.5 Enable Docker Desktop WSL2 integration

Docker Desktop must be installed on Windows **and** its WSL2 integration must be
enabled for your distro, otherwise `docker` will not be found inside WSL2.

Steps:
1. Open **Docker Desktop** on Windows
2. Go to **Settings → Resources → WSL Integration**
3. Toggle on the distro you are using (e.g. `Ubuntu`)
4. Click **Apply & Restart**

Verify from WSL2:
```bash
docker version
# Expected: Client and Server version info (no "command not found" error)
```

> **Note:** This is required for Step 2.7 (`docker build` / `kind load docker-image`).
> If `docker` is missing in WSL2, fix this step before proceeding.

---

## 2. Steps

### Step 2.1 — Resolve Go module dependencies

`go.mod` is already committed with all required dependencies.
Run `go mod tidy` to download them and generate `go.sum`:

```bash
# WSL2 terminal — from workspace root
cd sigil
go mod tidy
# Expected: go.sum created/updated, no errors
```

If `go-sqlite3` fails to build (requires CGO):
```bash
sudo apt-get install -y gcc
go mod tidy
```

### Step 2.2 — Compile the protobuf definition

`sigil/proto/sigil.proto` is already written. Run `protoc` from inside the `sigil/` directory:

```bash
# WSL2 terminal — from sigil/ directory
cd /mnt/d/Projects/MeshLite/sigil

protoc \
  --go_out=internal/proto \
  --go_opt=paths=source_relative \
  --go-grpc_out=internal/proto \
  --go-grpc_opt=paths=source_relative \
  -I proto \
  proto/sigil.proto

ls internal/proto/
# Expected: sigil.pb.go  sigil_grpc.pb.go
```

If `internal/proto/` does not exist yet:
```bash
mkdir -p internal/proto
```

### Step 2.3 — Verify CA compiles and CA unit tests pass

```bash
# WSL2 terminal — from workspace root
cd sigil
go test ./internal/ca/... -v
# Expected: all tests PASS, including TestIssueLeafCert and TestRootCAInit
```

### Step 2.4 — Verify policy engine unit tests pass with 100% branch coverage

```bash
# WSL2 terminal — from workspace root
cd sigil
go test ./internal/policy/... -v -coverprofile=coverage.out
go tool cover -func=coverage.out | grep -E "^.*Evaluate|total"
# Expected: Evaluate function shows 100.0% coverage
#           total coverage: ~100% (all branches hit)
```

If coverage is below 100%:
```bash
go tool cover -html=coverage.out -o coverage.html
# Open coverage.html in browser to see which branches are not hit
# Add test cases for each red line before proceeding
```

### Step 2.5 — Run the Sigil server locally

```bash
# WSL2 terminal — from sigil/ directory
go run ./cmd/server/main.go \
  --config ../tests/fixtures/mesh-basic.yaml \
  --db /tmp/sigil-test.db \
  --root-key /tmp/sigil-root.key \
  --root-cert /tmp/sigil-root.crt \
  --kubeconfig ~/.kube/config
# Expected output:
# {"level":"INFO","msg":"Sigil CA initialized — generated new root CA"}
# {"level":"INFO","msg":"gRPC server listening","addr":":8443"}
# {"level":"INFO","msg":"REST server listening","addr":":8080"}
```

If the kind cluster is not reachable, Sigil will log a warning and continue without the registry:
```
{"level":"WARN","msg":"registry unavailable — pod watch disabled (no Kubernetes API reachable)",...}
```
This is acceptable for Tests 2.A–2.D. The registry is only required for Test 2.E (kind cluster deployment).

Leave this running in a background terminal for Steps 2.6 and 2.7.

### Step 2.6 — Run the fake agent and verify cert push

```bash
# WSL2 terminal (new tab) — from sigil/ directory
go run ./cmd/fake-agent/main.go --sigil localhost:8443
# Expected output within 2 seconds:
# Connected to Sigil at localhost:8443
# [PUSH] CertBundle: service_id=service-alpha expires_at=...
# [PUSH] CertBundle: service_id=service-beta expires_at=...
# [PUSH] PolicyBundle: rules=2 default_allow=false mtls_mode=enforce
```

### Step 2.7 — Deploy Sigil to the kind cluster

> **Pre-check:** Docker Desktop must have WSL2 integration enabled (see Section 1.5).
> The kind cluster must be running — verify with `kind get clusters`.
> If the cluster is not listed, recreate it first: `bash hack/dev-cluster.sh`

```bash
# WSL2 terminal — from workspace root

# Verify kind cluster is up before proceeding
kind get clusters
# Expected: meshlite-dev

# Build the Sigil container image (context is sigil/ — not workspace root)
docker build -t meshlite/sigil:phase2 sigil/

# Load the image into the kind cluster (kind does not pull from local Docker daemon by default)
kind load docker-image meshlite/sigil:phase2 --name meshlite-dev

# Create the mesh config ConfigMap — the pod will not start without this
# The chart mounts it at /config/mesh.yaml inside the container
kubectl create namespace meshlite-system --dry-run=client -o yaml | kubectl apply -f -
kubectl create configmap sigil-mesh-config \
  --from-file=mesh.yaml=tests/fixtures/mesh-basic.yaml \
  -n meshlite-system

# Install the Helm chart
helm install sigil ./charts/sigil \
  -n meshlite-system \
  --create-namespace \
  --set image.tag=phase2

kubectl get pods -n meshlite-system
# Expected: sigil-xxx in Running state (wait up to 60s)
```

If the pod is in CrashLoopBackOff:
```bash
kubectl logs -n meshlite-system deploy/sigil
# Look for startup errors (missing config, PVC not bound, proto load failure)
kubectl describe pod -n meshlite-system -l app=sigil
```

---

## 3. Tests

### Test 2.A — CA issues a valid SPIFFE certificate

```bash
# WSL2 terminal — Sigil must be running locally (Step 2.5)

# Extract the issued cert for service-alpha
# Sigil writes certs to /tmp/sigil-test.db — use the REST API to inspect
curl -s http://localhost:8080/api/v1/certs | python3 -m json.tool
# Expected: JSON array containing service-alpha and service-beta entries with expires_at

# Write the service-alpha cert to a file for openssl inspection
curl -s http://localhost:8080/api/v1/certs/service-alpha/cert.pem -o /tmp/svc-alpha.pem
curl -s http://localhost:8080/api/v1/certs/root-ca.pem -o /tmp/root-ca.pem

# Verify the cert chains back to the root CA
openssl verify -CAfile /tmp/root-ca.pem /tmp/svc-alpha.pem
# Expected: /tmp/svc-alpha.pem: OK

# Verify the SPIFFE URI is in the SAN
openssl x509 -in /tmp/svc-alpha.pem -text -noout | grep URI
# Expected: URI:spiffe://meshlite.local/cluster/dev/ns/meshlite-test/svc/service-alpha
```

**Pass condition:** `openssl verify` prints `OK` AND `grep URI` shows the correct `spiffe://` URI.

---

### Test 2.B — Policy engine: 100% branch coverage

```bash
# WSL2 terminal — from workspace root
cd sigil
go test ./internal/policy/... -v -coverprofile=coverage.out

go tool cover -func=coverage.out | grep "Evaluate"
# Expected: github.com/.../policy.(*PolicyEngine).Evaluate  100.0%
```

**Pass condition:** `Evaluate` shows `100.0%` branch coverage.

---

### Test 2.C — Fake agent receives cert + policy; config reload pushes update

```bash
# WSL2 terminal (tab 1) — start Sigil
go run ./cmd/server/main.go \
  --config ../tests/fixtures/mesh-basic.yaml \
  --db /tmp/sigil-test.db \
  --root-key /tmp/sigil-root.key \
  --root-cert /tmp/sigil-root.crt

# WSL2 terminal (tab 2) — start fake agent and keep it running (from sigil/)
go run ./cmd/fake-agent/main.go --sigil localhost:8443
# Expected within 2 seconds:
# [PUSH] CertBundle: service_id=service-alpha
# [PUSH] CertBundle: service_id=service-beta
# [PUSH] PolicyBundle: rules=2 default_allow=false

# WSL2 terminal (tab 3) — push a config update and time the push
time curl -s -X POST http://localhost:8080/api/v1/config \
  -H "Content-Type: application/yaml" \
  --data-binary @tests/fixtures/mesh-one-way.yaml
# Expected: {"status":"accepted"} in < 1s

# Back in tab 2 — within 5 seconds of the POST:
# Expected: [PUSH] PolicyBundle: rules=1 (or updated rule count from mesh-one-way.yaml)
```

**Pass condition:** Cert push arrives within 2s of connect AND policy update arrives within 5s of `POST /api/v1/config`.

---

### Test 2.D — Cert rotation pushes automatically before TTL expiry

```bash
# WSL2 terminal (tab 1) — start Sigil with 30-second test TTL
go run ./cmd/server/main.go \
  --config ../tests/fixtures/mesh-basic.yaml \
  --db /tmp/sigil-rotation-test.db \
  --root-key /tmp/sigil-root.key \
  --root-cert /tmp/sigil-root.crt \
  --test-cert-ttl=30s

# WSL2 terminal (tab 2) — start fake agent immediately (from sigil/)
go run ./cmd/fake-agent/main.go --sigil localhost:8443
# Expected: initial CertBundle push for both services

# Wait 25-28 seconds. Expected in tab 2 (before 30s expiry):
# [ROTATION] CertBundle: service_id=service-alpha new_expires_at=<later timestamp>
# [ROTATION] CertBundle: service_id=service-beta new_expires_at=<later timestamp>
# No reconnect should occur — this must arrive on the existing stream
```

**Pass condition:** New `CertBundle` arrives on the existing gRPC stream ≥5s before TTL expiry. `new_expires_at` is later than the original `expires_at`. No reconnect log line appears.

---

### Test 2.E — Kind cluster deployment, health check, restart, RAM

```bash
# WSL2 terminal — Sigil already deployed in kind (Step 2.7)

# Health check — forward the HTTP port (8080), not the gRPC port (8443)
kubectl port-forward -n meshlite-system svc/sigil 8080:8080 &
sleep 1
curl -s http://localhost:8080/healthz
# Expected: {"status":"ok"}

# RAM at idle
kubectl top pod -n meshlite-system -l app=sigil
# Expected: Memory column shows < 80Mi

# Restart test
kubectl rollout restart deployment/sigil -n meshlite-system
kubectl rollout status deployment/sigil -n meshlite-system --timeout=60s
# Expected: "successfully rolled out"

kubectl logs -n meshlite-system -l app=sigil --since=30s
# Expected: "Sigil CA initialized — loaded existing root CA from disk"
# Must NOT see: "generating new root CA" (that would mean it re-issued)
```

**Pass condition:** `/healthz` → `{"status":"ok"}`, RAM < 80Mi, restart log shows "loaded existing root CA from disk".

---

## 4. Exit Criteria Checklist

- [ ] **2.1** — `openssl verify` passes against Sigil root CA → [Test 2.A](#test-2a--ca-issues-a-valid-spiffe-certificate)
- [ ] **2.2** — SPIFFE URI in SAN matches `spiffe://meshlite.local/cluster/dev/...` → [Test 2.A](#test-2a--ca-issues-a-valid-spiffe-certificate)
- [ ] **2.3** — Policy engine `Evaluate()` branch coverage = 100% → [Test 2.B](#test-2b--policy-engine-100-branch-coverage)
- [ ] **2.4** — Fake agent receives cert + policy within 2s of connect → [Test 2.C](#test-2c--fake-agent-receives-cert--policy-config-reload-pushes-update)
- [ ] **2.5** — Config reload pushes updated policy within 5s → [Test 2.C](#test-2c--fake-agent-receives-cert--policy-config-reload-pushes-update)
- [ ] **2.6** — Cert rotation pushes automatically before TTL expiry, no reconnect → [Test 2.D](#test-2d--cert-rotation-pushes-automatically-before-ttl-expiry)
- [ ] **2.7** — Restart reloads existing root CA, does not regenerate → [Test 2.E](#test-2e--kind-cluster-deployment-health-check-restart-ram)
- [ ] **2.8** — Kind deployment passes `/healthz`, RAM < 80Mi → [Test 2.E](#test-2e--kind-cluster-deployment-health-check-restart-ram)

---

## 5. Teardown

```bash
# WSL2 terminal
# Uninstall Sigil from cluster
helm uninstall sigil -n meshlite-system
kubectl delete namespace meshlite-system

# Remove local test artefacts
rm -f /tmp/sigil-test.db /tmp/sigil-rotation-test.db /tmp/svc-alpha.pem /tmp/root-ca.pem
```

The kind cluster and test pods (service-alpha, service-beta) are left running — they are reused in Phase 3.

---

## 6. Troubleshooting

| Symptom | Root cause | Resolution |
|---|---|---|
| `protoc-gen-go: program not found` | Go bin not in PATH | `export PATH=$PATH:$(go env GOPATH)/bin` then re-run |
| `go-sqlite3` fails to build: `cgo: C compiler not found` | CGO requires gcc | `sudo apt-get install -y gcc` |
| `go-sqlite3` fails on cross-compile | CGO can't cross-compile | Build and run only on the target platform (WSL2 Linux); do not build from PowerShell |
| `kind load docker-image` hangs | kind cluster not running | `kind get clusters` — if empty, run `hack/dev-cluster.sh` |
| Sigil pod: `CrashLoopBackOff` | Startup error | `kubectl logs -n meshlite-system deploy/sigil` to see the error |
| Fake agent: `connection refused localhost:8443` | Sigil server not started | Start Sigil first (Step 2.5) before running fake agent |
| `openssl verify` fails: `certificate signed by unknown authority` | Root CA file is wrong | Re-fetch from `GET /api/v1/certs/root-ca.pem` after Sigil restart |
| Cert rotation test: rotation fires before fake agent connects | Race with 30s TTL | Use `--test-cert-ttl=60s` and connect agent immediately |
| `kubectl top pod` not working | metrics-server not installed in kind | `kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml` then patch: `kubectl patch deployment metrics-server -n kube-system --type=json -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'` — wait 60s |
| Port-forward drops after ~5min | Kubernetes port-forward timeout | Re-run `kubectl port-forward` command |
| `grpcurl --version` shows `dev build <no version set>` | Installed via `go install` which embeds no version tag | Normal — the tool works correctly; ignore the version string |
| `open /data/root.key: no such file or directory` | Default `--root-key` path is for the container (`/data/`); not valid locally | Pass `--root-key /tmp/sigil-root.key --root-cert /tmp/sigil-root.crt` explicitly when running locally |
| `panic: flag redefined: kubeconfig` | `controller-runtime` registers `--kubeconfig` globally via `init()` — our code must not redefine it | Fixed in code: use `flag.Lookup("kubeconfig")` instead of `flag.String("kubeconfig", ...)` |
| `The command 'docker' could not be found in this WSL 2 distro` | Docker Desktop WSL2 integration not enabled for this distro | Open Docker Desktop → Settings → Resources → WSL Integration → enable your distro → Apply & Restart |
| `docker build … go.mod requires go >= 1.25.0 (running go 1.22)` | Dockerfile base image was `golang:1.22-alpine` but go.mod requires 1.25 | Changed Dockerfile to `FROM golang:1.25-alpine` |
| `docker build … "/go.sum": not found` | Build context was workspace root (`.`) but Dockerfile paths are relative to `sigil/` | Use `docker build -t meshlite/sigil:phase2 sigil/` — pass `sigil/` as context, not `.` |
| `kind load … ERROR: no nodes found for cluster "meshlite-dev"` | kind cluster was torn down | Recreate with `bash hack/dev-cluster.sh`, then retry `kind load` |
| Pod stuck in `ContainerCreating` with `MountVolume.SetUp failed … configmap "sigil-mesh-config" not found` | ConfigMap was not created before `helm install` | Run: `kubectl create configmap sigil-mesh-config --from-file=mesh.yaml=tests/fixtures/mesh-basic.yaml -n meshlite-system` |
