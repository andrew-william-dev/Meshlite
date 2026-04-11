# MeshLite — Phase 6 Approach
## Packaging, CI/CD, and Release Distribution

---

## 1. Goal

Prove that MeshLite can be **validated, packaged, and shipped as a consumable Helm-based release** with automated GitHub Actions pipelines that build, test, smoke-check images, and publish versioned OCI images and Helm charts to GHCR.

---

## 2. Scope

### In scope

| Item | Description |
|---|---|
| Umbrella Helm chart | Add `charts/meshlite/` so a consumer can install the platform from a single chart |
| Release-friendly chart defaults | Move charts from local `meshlite/*:phaseX` images to GHCR-ready repositories and semver-friendly tags |
| CI workflow | Fast validation on PRs / pushes for Go, Rust, frontend, and Helm packaging |
| Release workflow | Build and publish container images and OCI Helm charts to GHCR on `v*.*.*` tags or manual dispatch |
| Local validation scripts | Reusable PowerShell scripts for CI and operator-side validation / packaging |
| Deployment documentation | A clear install / release runbook for local, kind, and private/internal EKS-style consumption |

### NOT in scope

- Full HA production topology for Sigil / Trace
- Secrets management beyond Helm values and standard Kubernetes secrets
- Progressive delivery / canary rollout tooling
- Public SaaS hosting of Trace
- Auth / RBAC hardening beyond the existing private/internal access model
- SBOM signing / provenance attestation (can be added later)

---

## 3. Components

1. **GitHub Actions CI**
   - runs the core test/build suite on every code change,
   - caches Go, Rust, and npm dependencies,
   - smoke-builds Docker images when container-related files change.

2. **GitHub Actions Release**
   - triggers on `v*.*.*` tags or manual dispatch,
   - publishes `sigil`, `kprobe`, `conduit`, and `trace` images to `ghcr.io/<owner>/meshlite/*`,
   - packages and publishes Helm charts as OCI artifacts to `oci://ghcr.io/<owner>/charts`.

3. **Umbrella chart**
   - installs `sigil`, `kprobe`, and `trace` by default,
   - exposes optional `conduit` egress / ingress toggles for cross-cluster deployments,
   - supports private/internal Trace ingress.

---

## 4. Dependencies

| Dependency | Status |
|---|---|
| Phase 5 MVP code and docs | ✅ complete |
| Working Helm charts for `sigil`, `kprobe`, `conduit`, `trace` | ✅ present |
| Dockerfiles for all runtime components | ✅ present |
| GitHub repository remote | ✅ `origin` configured |

---

## 5. Exit Criteria

| ID | Criterion |
|---|---|
| **6.A** | `helm dependency update charts/meshlite` and `helm template charts/meshlite` both succeed |
| **6.B** | The new validation pipeline runs the crucial Go/Rust/frontend/Helm checks from a single reusable script |
| **6.C** | Docker smoke builds are wired into CI for the four runtime images |
| **6.D** | A release workflow is present to publish OCI images and Helm charts to GHCR |
| **6.E** | Consumers have documented install commands for `helm install` from the published OCI chart |

---

## 6. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Linux-only build/runtime assumptions in Kprobe and Sigil | Medium | Run the full release validation on Ubuntu runners and allow Windows host scripts to skip known incompatible checks |
| Helm defaults still point to local dev images | High | Switch chart defaults to GHCR repositories and semver-style release tags |
| Release pipeline may publish broken artifacts if packaging is not tested locally | High | Use the same local packaging script in CI and release jobs |
| Operators may confuse private/internal Trace access with public production exposure | Medium | Keep the deployment docs explicit: no-auth mode is for private/internal access only |
