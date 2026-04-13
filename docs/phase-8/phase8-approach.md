# MeshLite — Phase 8 Approach

## meshctl Distribution — Binary Release Pipeline

> **Status:** Draft — awaiting review  
> **Author:** GitHub Copilot  
> **Date:** April 13, 2026

---

## 1. Goal

Ship `meshctl` as a downloadable, versioned binary so the operator CLI works from any terminal without needing the Go source tree — and add it as an optional post-install verifier inside the Helm chart for CI/cluster-side validation.

### Deployment answer (short version)

`meshctl` is **not deployed as a long-running Helm workload** for terminal usage.

- For operators/devs: deploy by installing a versioned binary to local PATH (primary path).
- For cluster verification: deploy as an optional one-shot Helm hook Job that runs `meshctl status` and exits.

---

## 2. Scope

### In scope

| Area | What is delivered |
|------|-------------------|
| **Binary releases** | Multi-platform `meshctl` binaries (5 targets) attached to every GitHub Release |
| **Version injection** | Build-time ldflags inject the git tag into `meshctl version` output |
| **Install scripts** | `hack/install-meshctl.sh` (Unix curl-pipe) and `hack/install-meshctl.ps1` (PowerShell) |
| **CI pipeline** | New `publish-meshctl` job in `release.yml` that runs after the validate stage |
| **Helm hook (optional)** | Post-install Kubernetes Job that runs `meshctl status` as a smoke test |
| **meshctl container image** | Minimal scratch image `ghcr.io/.../meshlite/meshctl:vX.Y.Z` used by the Helm Job |

### Explicitly NOT in scope this phase

- Homebrew formula or tap
- APT / RPM / AUR packages
- Automatic update / self-upgrade (`meshctl upgrade`)
- Windows `.msi` installer
- meshctl `init` command that configures kubeconfig and sigil-url automatically
- Any new CLI commands (existing: apply, status, verify, logs, rotate, version)

---

## 3. Architecture Decisions

### 3A — Why binary release assets, not Helm-only?

The current workflow requires `go run ./meshctl ...` against a local source tree. This blocks anyone without Go installed and couples the CLI to the repo working copy. Publishing static binaries decouples the two.

### 3A.1 — Deployment model by target environment

| Target | Deployment method | Lifetime | Owner |
|--------|-------------------|----------|-------|
| Developer/operator terminal | Install `meshctl` binary (or installer script) into PATH | Persistent until upgraded | User machine |
| Kubernetes runtime checks | Helm post-install/post-upgrade Job using `meshctl` container image | One-shot and exits | Helm release |

This split keeps interactive CLI usage simple and avoids shipping an always-on meshctl pod that provides no continuous runtime value.

### 3B — Why also a Helm Job hook?

`meshctl status` hits Sigil's `/api/v1/certs` and `/api/v1/policy` and Trace's `/api/v1/summary`. This is a perfect post-install smoke test: if the Job completes successfully, all three components are reachable and healthy. The Job is opt-in (`meshctl.hookEnabled: false` by default).

### 3C — Version injection strategy

`cmd/root.go` already declares `version = "v0.5.0-mvp"`. We change this to `version = "dev"` (sentinel) and inject the real value at build time:

```
go build -ldflags "-X github.com/meshlite/meshctl/cmd.version=v0.5.4" ...
```

The CI pipeline reads the version from `$GITHUB_REF_NAME` (tag) or `workflow_dispatch` input, exactly as the existing `publish-charts` job does.

### 3D — Platform matrix

| GOOS | GOARCH | Archive format | Notes |
|------|--------|----------------|-------|
| linux | amd64 | `.tar.gz` | Primary dev / CI target |
| linux | arm64 | `.tar.gz` | Raspberry Pi / ARM cloud |
| darwin | amd64 | `.tar.gz` | Intel Mac |
| darwin | arm64 | `.tar.gz` | Apple Silicon (M1/M2/M3) |
| windows | amd64 | `.zip` | Developer workstations |

---

## 4. Components

### 4.1 Pipeline: `release.yml` — new `publish-meshctl` job

Runs after `validate`, in parallel with `publish-images`. Steps:

1. Checkout
2. Setup Go `1.25.0`
3. Resolve version (same logic as `publish-charts`)
4. Build 5 binaries in a matrix (CGO_ENABLED=0, ldflags version injection)
5. Archive each binary (`.tar.gz` or `.zip`)
6. Attach archives to the GitHub Release via `softprops/action-gh-release`

### 4.2 Container image: `meshctl` Docker image

Minimal two-stage Dockerfile (`golang:1.25-alpine` builder → `scratch` runtime). Published alongside the other component images by extending the existing `publish-images` matrix.

Used by the Helm Job hook so it does not need a binary mount.

It is **not** the primary delivery mechanism for human CLI usage.

### 4.3 Install scripts

**`hack/install-meshctl.sh`** (Unix):
```
curl -sSfL https://raw.githubusercontent.com/.../hack/install-meshctl.sh | sh
```
- Detects OS and arch
- Downloads the matching archive from the latest GitHub Release
- Extracts to `/usr/local/bin/meshctl`
- Prints `meshctl version` to confirm

**`hack/install-meshctl.ps1`** (Windows PowerShell):
```powershell
irm https://raw.githubusercontent.com/.../hack/install-meshctl.ps1 | iex
```
- Same approach: detect arch, download `.zip`, extract to `$env:LOCALAPPDATA\meshctl\`
- Adds to user `$PATH` permanently via `[Environment]::SetEnvironmentVariable`

### 4.4 Helm — optional post-install Job hook

New template `charts/meshlite/templates/meshctl-verify-job.yaml`:

- Kind: `Job` with `helm.sh/hook: post-install,post-upgrade`
- Runs `meshctl status --sigil-url http://sigil.{{ .Release.Namespace }}.svc.cluster.local:8080`
- Image: `ghcr.io/.../meshlite/meshctl:{{ .Chart.AppVersion }}`
- Controlled by `meshctl.hookEnabled` value (default `false`)
- `backoffLimit: 1`, `ttlSecondsAfterFinished: 120`

---

## 5. Dependencies

- Phase 6 complete: `release.yml` already handles validate → publish-images → publish-charts.
- `meshctl/go.mod` already has a valid module path (`github.com/meshlite/meshctl`).
- GHCR push permission already granted (`permissions: packages: write` in release.yml).
- GitHub Release creation already handled by `softprops/action-gh-release` step (we extend it, not replace it).

---

## 6. Exit Criteria

| # | Criterion | How to verify |
|---|-----------|---------------|
| EC-1 | `meshctl version` prints the tagged semver (e.g. `meshctl v0.5.5`), not `dev` or `v0.5.0-mvp` | Run `meshctl version` after installing from release asset |
| EC-2 | Linux amd64 binary downloads and runs on a machine without Go installed | `curl` download script + `meshctl version` |
| EC-3 | Windows amd64 binary works in PowerShell | Install script + `meshctl version` |
| EC-4 | Apple Silicon binary works on macOS arm64 | `meshctl version` on M-series Mac |
| EC-5 | `meshctl status` returns live data after port-forwarding Sigil and Trace | Port-forward + `meshctl status` |
| EC-6 | Helm post-install Job completes with exit 0 after `helm upgrade` | `kubectl get jobs -n meshlite-system` shows `Completed` |
| EC-7 | `release.yml` publishes all 5 binary archives to the GitHub Release page | GitHub Releases page shows `.tar.gz`/`.zip` assets |

---

## 7. Risk Items

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| CGO dependency in meshctl breaks cross-compilation | Low | meshctl uses only `net/http` + cobra — pure Go; CGO_ENABLED=0 is safe |
| `meshctl` scratch container too small (missing TLS root certs) | Medium | Add `ca-certificates` to the image stage before copying to scratch |
| Helm Job fails if Sigil is not yet ready when Job runs | Medium | Add `initContainer` that polls Sigil `/healthz` before running status command |
| Install script URL hard-coded to wrong branch | Low | Source URL should reference the latest release tag, not a branch |
| Windows `$PATH` update requires terminal restart | Low | Document in install script output and in the runbook |

---

## 8. Proposed Phase Sequence

```
Stage 1 — Approach      ← this document (review and agree before proceeding)
Stage 2 — Runbook       → docs/phase-8/phase8-runbook.md
Stage 3 — Coding        → pipeline job, Dockerfile, install scripts, Helm hook
Stage 4 — Execution     → tag a test release, verify downloads, run install scripts
Stage 5 — Report        → docs/phase-8/phase8-outcome-report.md
Stage 6 — Discussion    → merge to main, update timeline.md
```

---

## Review Checklist

- [ ] Platform matrix confirmed (especially: do you need linux/arm64 and darwin/amd64?)
- [ ] Helm hook opt-in by default confirmed (`hookEnabled: false`)
- [ ] Install script delivery method confirmed (raw GitHub URL vs separate CDN)
- [ ] Version sentinel `"dev"` acceptable (vs keeping a hardcoded fallback)
- [ ] meshctl container image added to the `publish-images` matrix confirmed
