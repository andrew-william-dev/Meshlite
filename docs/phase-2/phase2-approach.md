# MeshLite — Phase 2 Approach
## Sigil: Certificate Authority and Control Plane

> **Status:** Approach — under review
> **Date:** April 4, 2026
> **Follows:** Phase 1 Outcome Report (`docs/phase-1/phase1-outcome-report.md`)
> **Do not start the runbook until this document is reviewed and agreed.**

---

## 1. Goal

Build a working Sigil service that issues SPIFFE x509 certificates for service identities, persists them in SQLite, pushes them to connected agents via a gRPC streaming connection, and rotates them automatically before TTL expiry.

---

## 2. Scope

### In Scope

| Item | Description |
|---|---|
| Protobuf definitions | `CertBundle`, `PolicyBundle`, `AgentHello`, `AgentPush`, `SigilAgent` RPC — the contract between Go and Rust |
| Certificate Authority | Self-signed root CA key generation, leaf cert issuance (SPIFFE SVID format), SQLite persistence, revocation |
| Policy Engine | Parse `mesh.yaml` allow rules into an in-memory graph; `Evaluate(from, to)` returns Allow/Deny |
| Service Registry | Watch the Kubernetes API for pod events; register/deregister service identities |
| Policy Distributor | gRPC server-streaming: one connection per Kprobe agent; cert push on rotation; policy push on config change |
| Sigil API | `POST /api/v1/config`, `GET /api/v1/certs`, `GET /api/v1/policy`, `GET /healthz`, gRPC `SigilAgent.Connect` |
| Helm chart | Single-replica Deployment in `meshlite-system`; PersistentVolume for SQLite; port 8443 |
| Fake agent fixture | Go program in `tests/fixtures/fake-agent/` used to simulate a Kprobe agent during Test 2.C and 2.D |

### Explicitly Out of Scope

- **mTLS enforcement in Kprobe** — Kprobe continues to run in Phase 1 passthrough mode. Phase 3 wires Kprobe to Sigil.
- **TLS on the Sigil gRPC endpoint** — the agent connection runs plaintext in Phase 2. TLS is added in Phase 3 when Kprobe holds a cert to present.
- **Conduit (cross-cluster gateway)** — Phase 4.
- **Trace (observability dashboard)** — Phase 5.
- **meshctl CLI** — Phase 5, except the `meshctl apply` command is stubbed as a plain `curl` in test commands.
- **Multi-cluster Sigil federation** — single cluster only.
- **CRL / OCSP** — revocation is SQLite delete + empty bundle push. No external revocation protocol.
- **Production hardening** (HSM, encrypted SQLite, RBAC on the API) — deferred.

---

## 3. Components

All new code lives in these directories. Everything else in the repo is unchanged.

```
sigil/
├── cmd/
│   └── server/
│       └── main.go               ← entrypoint: wire up all components, start server
├── internal/
│   ├── ca/
│   │   ├── ca.go                 ← root CA init, leaf cert issuance, SQLite persistence
│   │   └── ca_test.go
│   ├── policy/
│   │   ├── engine.go             ← mesh.yaml parser, allow-graph, Evaluate()
│   │   └── engine_test.go        ← 100% branch coverage target
│   ├── registry/
│   │   └── registry.go           ← controller-runtime pod watcher
│   └── distributor/
│       └── distributor.go        ← gRPC server-streaming, cert/policy push
├── proto/
│   └── sigil.proto               ← shared contract (generates Go + Rust clients)
└── go.mod / go.sum

tests/fixtures/fake-agent/
└── main.go                       ← simulate Kprobe agent; used in Tests 2.C and 2.D

charts/sigil/
├── Chart.yaml
├── values.yaml
└── templates/
    ├── deployment.yaml
    ├── service.yaml
    └── pvc.yaml
```

**New tools required on the dev machine:**

| Tool | Version | Why |
|---|---|---|
| Go | 1.22+ | Sigil is written in Go |
| `protoc` | 25+ | Generate Go types from `sigil.proto` |
| `protoc-gen-go` | latest | Go plugin for protoc |
| `protoc-gen-go-grpc` | latest | gRPC Go plugin |
| `grpcurl` | latest | Manual gRPC endpoint testing |
| Helm | 3.14+ | Deploy Sigil chart to kind cluster |

---

## 4. Dependencies

The following must be confirmed working before starting the runbook:

| Dependency | Where it was delivered | How to verify |
|---|---|---|
| kind cluster `meshlite-dev` (1 control-plane + 2 workers) | Phase 1 `hack/dev-cluster.sh` | `kubectl get nodes` → 3 nodes Ready |
| `service-alpha` and `service-beta` pods running | Phase 1 `tests/fixtures/test-services.yaml` | `kubectl get pods -n meshlite-test` → 2 Running |
| Kprobe loader in Phase 1 passthrough mode | Phase 1 | Not required to be running during Phase 2 |
| `tests/fixtures/mesh-basic.yaml` fixture | Phase 1 | File exists, used for Tests 2.B and 2.C |

> **Note:** The Kprobe loader does not need to be running during Phase 2. Sigil is built and tested in isolation. The integration with Kprobe happens in Phase 3.

---

## 5. Exit Criteria

All eight conditions must be true before Phase 2 is closed. Each maps to one test in the runbook.

| ID | Criterion | Test |
|---|---|---|
| **2.1** | Sigil generates a valid self-signed root CA on first startup and persists the key pair to disk | Test 2.A |
| **2.2** | Issued leaf certs are valid SPIFFE SVIDs — `openssl verify` passes against the Sigil root CA, and SAN contains the correct `spiffe://` URI | Test 2.A |
| **2.3** | Policy engine unit tests pass with 100% branch coverage on `Evaluate()` | Test 2.B |
| **2.4** | Fake agent connects via gRPC and receives correct `CertBundle` + `PolicyBundle` within 2 seconds of handshake | Test 2.C |
| **2.5** | `POST /api/v1/config` with an updated `mesh.yaml` pushes the new `PolicyBundle` to all connected agents within 5 seconds | Test 2.C (config reload sub-step) |
| **2.6** | Cert rotation: a cert issued with a 30-second TTL is automatically replaced and pushed to the connected agent before expiry, with no agent reconnect required | Test 2.D |
| **2.7** | Sigil pod restarts cleanly, reloads the persisted root CA, and reconnects all agents without re-issuing certs unnecessarily | Test 2.E (restart sub-step) |
| **2.8** | Sigil deployed in kind cluster passes `GET /healthz`, and RAM consumption is under 80MB at idle | Test 2.E |

---

## 6. Risk Items

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `protoc` + `protoc-gen-go` version mismatch generates broken stubs | Medium | High — blocks all gRPC tests | Pin exact versions in the runbook; generate and commit generated stubs. |
| `controller-runtime` pod watcher requires a real Kubernetes API server — integration test is harder to fake | Medium | Medium | Run registry tests against the live kind cluster, not a fake server. |
| SQLite WAL mode contention between CA writer and API reader | Low | Low | SQLite in WAL mode handles single-writer/multiple-reader safely; no special locking needed. |
| SPIFFE URI format mismatch between what Sigil issues and what Kprobe expects in Phase 3 | Medium | High — breaks Phase 3 integration | Lock the format now: `spiffe://meshlite.local/cluster/{clusterID}/ns/{namespace}/svc/{serviceName}`. Do not change it. |
| gRPC server-streaming keeps idle connections open; kind node OOM-kills Sigil under test | Low | Medium | Set keepalive pings; cap max open streams in Helm values. |
| Go `crypto/x509` does not set the correct `ExtKeyUsage` for SPIFFE SVIDs | Low | Medium | Write a unit test that re-parses the issued cert and asserts the exact OID values. Include in exit criterion 2.2. |
| Cert rotation timer fires before the fake agent is connected in Test 2.D | Low | Low | Pass `--test-cert-ttl=30s` flag; connect fake agent immediately after Sigil starts before rotation fires. |

---

## Decision Log

The following decisions are made as part of this approach and are locked in for all future phases:

1. **SPIFFE URI format is fixed:** `spiffe://meshlite.local/cluster/{clusterID}/ns/{namespace}/svc/{serviceName}`. Any deviation breaks Phase 3 cert verification.
2. **Sigil persists the root CA private key in a file on a PVC.** It is not held only in memory. This means Sigil can restart without re-issuing every cert.
3. **The gRPC agent endpoint (`SigilAgent.Connect`) runs plaintext in Phase 2.** TLS is added in Phase 3 once Kprobe can present a cert. Plaintext is acceptable because this is running inside a kind cluster on a developer machine.
4. **SQLite is the persistence layer for Phase 2.** PostgreSQL or etcd is not introduced until there is a clear need (multi-replica Sigil). That need does not exist in Phase 2.
5. **Policy engine tests target 100% branch coverage.** This is the most critical logic in the system — a missed branch is a security vulnerability.
