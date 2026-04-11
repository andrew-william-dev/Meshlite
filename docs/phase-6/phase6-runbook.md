# MeshLite — Phase 6 Runbook
## Packaging, CI/CD, and Release Distribution

> **Goal:** validate MeshLite locally, publish runtime images to GHCR, and ship a single Helm install path for consumers.

---

## 1. Prerequisites

- GitHub repository with Actions enabled
- GHCR access through `GITHUB_TOKEN`
- Helm `3.14+`
- Docker `24+`
- Go `1.25+`
- Rust stable toolchain
- Node.js `20+`

---

## 2. Local validation before any release

Run the shared validation script from the repo root:

```powershell
pwsh ./hack/validate-ci.ps1
```

What it validates:

- Go tests for `trace/backend`, `meshctl`, and `sigil` where supported
- Rust tests for `conduit` and `kprobe-userspace` where supported
- `npm ci` + `npm run build` for `trace/frontend`
- `helm lint` for all component charts
- `helm dependency update`, `helm lint`, and `helm template` for the new umbrella chart

---

## 3. Package the charts locally

```powershell
pwsh ./hack/package-release.ps1 -Version 0.5.0 -Destination .release/charts
```

Expected output:

- `.release/charts/sigil-0.5.0.tgz`
- `.release/charts/kprobe-0.5.0.tgz`
- `.release/charts/conduit-0.5.0.tgz`
- `.release/charts/trace-0.5.0.tgz`
- `.release/charts/meshlite-0.5.0.tgz`

---

## 4. CI workflow behavior

### Pull requests / pushes to `main`

Workflow: `.github/workflows/ci.yml`

- skips when only irrelevant files changed,
- caches Go, Rust, and npm dependencies,
- runs the shared validation suite,
- smoke-builds runtime images when Docker-related files changed.

---

## 5. Release workflow behavior

### Trigger by tag

```bash
git tag v0.5.0
git push origin v0.5.0
```

### Or trigger manually from GitHub Actions

Workflow: `.github/workflows/release.yml`

The release job will:

1. re-run the core validation suite,
2. publish the four runtime images to:
   - `ghcr.io/<owner>/meshlite/sigil`
   - `ghcr.io/<owner>/meshlite/kprobe`
   - `ghcr.io/<owner>/meshlite/conduit`
   - `ghcr.io/<owner>/meshlite/trace`
3. package and push Helm charts to:
   - `oci://ghcr.io/<owner>/charts`
4. create a GitHub release with the chart archives attached.

---

## 6. Consumer install path

### Single-cluster install

```bash
helm install meshlite oci://ghcr.io/andrew-william-dev/charts/meshlite \
  --version 0.5.0 \
  --namespace meshlite-system \
  --create-namespace
```

### Private/internal EKS-style Trace access

```bash
helm install meshlite oci://ghcr.io/andrew-william-dev/charts/meshlite \
  --version 0.5.0 \
  --namespace meshlite-system \
  --create-namespace \
  -f charts/meshlite/examples/eks-internal-values.yaml
```

This enables the intended MVP access model:

- Trace stays inside the cluster,
- access is through an internal ALB / ingress and private DNS,
- no-auth mode remains private/internal only.

---

## 7. Post-install checks

```bash
kubectl get pods -n meshlite-system
kubectl -n meshlite-system port-forward svc/trace 3000:3000 9090:9090
meshctl --sigil-url http://127.0.0.1:8080 --trace-url http://127.0.0.1:3000 status
```

Expected results:

- all core pods become `Running` / `Ready`,
- Trace opens on `http://127.0.0.1:3000`,
- `meshctl status` reports the live policy/cert summary.

---

## 8. Release recommendation

Use the CI workflow on every PR and reserve the release workflow for **versioned tags only**. That keeps the pipeline fast during development while still producing deterministic, consumable artifacts for real installs.
