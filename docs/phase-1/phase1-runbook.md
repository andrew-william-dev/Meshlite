# MeshLite — Phase 1 Developer Runbook
## eBPF Traffic Interception: Local Setup & Testing Guide

> **Audience:** A developer joining the project who wants to run Phase 1 end-to-end on their own machine and verify every exit criterion.
>
> **Goal of Phase 1:** Prove that an eBPF program loaded via Aya can intercept a real TCP packet between two pods on a Kubernetes node, log it, and return control without disrupting the connection. No mTLS, no policy — pure interception PoC.
>
> **Time to complete:** ~1–2 hours (excluding WSL2/Docker install time)

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Repository Layout (Phase 1 Scope)](#2-repository-layout-phase-1-scope)
3. [One-Time Machine Setup](#3-one-time-machine-setup)
4. [Step 1 — Spin Up the Local Kubernetes Cluster](#4-step-1--spin-up-the-local-kubernetes-cluster)
5. [Step 2 — Build the eBPF Program](#5-step-2--build-the-ebpf-program)
6. [Step 3 — Build the Userspace Loader](#6-step-3--build-the-userspace-loader)
7. [Step 4 — Deploy the Userspace Loader as a DaemonSet](#7-step-4--deploy-the-userspace-loader-as-a-daemonset)
8. [Test 1.A — Does the eBPF Hook Fire?](#8-test-1a--does-the-ebpf-hook-fire)
9. [Test 1.B — Interception Does Not Break Connectivity](#9-test-1b--interception-does-not-break-connectivity)
10. [Test 1.C — Pod Traffic Only, Not Host Traffic](#10-test-1c--pod-traffic-only-not-host-traffic)
11. [Test 1.D — Performance Baseline](#11-test-1d--performance-baseline)
12. [Phase 1 Exit Criteria Checklist](#12-phase-1-exit-criteria-checklist)
13. [Teardown](#13-teardown)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. Prerequisites

### 1.1 Host machine requirements

| Requirement | Why |
|---|---|
| Windows 11 or Windows 10 (build 19041+) | WSL2 requires these builds |
| WSL2 installed and working | eBPF runs only on Linux kernel 5.15+ |
| Ubuntu 22.04 or 24.04 inside WSL2 | Our tested Linux environment |
| Docker Desktop (WSL2 backend) | Powers kind clusters |
| 8 GB RAM minimum | kind cluster + Docker + WSL2 overhead |
| 15 GB free disk | Docker images + Rust build cache |

### 1.2 Tools (already installed by the setup script)

These were installed during the initial environment setup. Verify they are all present before starting:

```powershell
# Run in a NEW PowerShell window (not the one used during install)
rustc --version       # expect 1.75+
cargo --version
go version            # expect 1.22+
node --version        # expect 20+
docker --version      # expect 24+
kind version          # expect 0.22+
kubectl version --client
helm version
grpcurl --version
protoc --version
```

### 1.3 WSL2 requirement — critical for eBPF

The eBPF program (`kprobe-ebpf`) targets the `bpfel-unknown-none` architecture and runs inside the Linux kernel via Aya. **This cannot run on Windows natively.** All eBPF-related commands in this guide are run inside WSL2.

**Verify WSL2 is working:**
```powershell
# In PowerShell
wsl --status
# Expected: "Default Distribution: Ubuntu" or similar
# Expected: "Default Version: 2"

wsl uname -r
# Expected: 5.15.x or higher (e.g. 5.15.167.4-microsoft-standard-WSL2)
```

**If WSL2 is broken**, fix it before proceeding:
```powershell
# In PowerShell as Administrator
wsl --install
# Restart when prompted. Then:
wsl --set-default-version 2
```

---

## 2. Repository Layout (Phase 1 Scope)

```
MeshLite/
├── kprobe/
│   ├── Cargo.toml                  ← Rust workspace root
│   ├── rust-toolchain.toml         ← Pins nightly + rust-src
│   ├── .cargo/config.toml          ← MinGW64 linker for Windows host
│   │
│   ├── kprobe-ebpf/                ← Kernel-side eBPF program (no_std)
│   │   ├── Cargo.toml              ← aya-ebpf dependency
│   │   ├── .cargo/config.toml      ← target = bpfel-unknown-none, build-std=core
│   │   └── src/main.rs             ← TC egress hook + PacketLog + PerfEventArray
│   │
│   └── kprobe-userspace/           ← Userspace loader
│       ├── Cargo.toml              ← aya, tokio, anyhow dependencies
│       └── src/main.rs             ← Loads eBPF, attaches TC, polls perf events
│
├── tests/
│   └── fixtures/
│       ├── test-services.yaml      ← service-alpha + service-beta deployments
│       ├── mesh-basic.yaml         ← Basic allow-list policy (Phase 2+)
│       └── mesh-one-way.yaml       ← One-way policy for DENY test (Phase 3)
│
└── hack/
    ├── kind-config.yaml            ← 1 control-plane + 2 workers
    ├── dev-cluster.sh              ← Creates cluster + deploys test pods
    └── teardown.sh                 ← Deletes clusters
```

---

## 3. One-Time Machine Setup

> Skip this section if you already completed the environment setup. Run the verification commands in §1.2 first to confirm.

### 3.1 Set up WSL2 with Ubuntu

```powershell
# PowerShell (as Administrator)
wsl --install -d Ubuntu-24.04
# Restart when prompted.
# Set a username and password when Ubuntu first starts.
```

### 3.2 Install Rust inside WSL2

The eBPF crate must be built inside WSL2 (Linux), not on the Windows host. The Rust toolchain installed on Windows is only used to check the userspace crate.

```bash
# Inside WSL2 (Ubuntu)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# Install nightly with rust-src (required for build-std=core)
rustup toolchain install nightly --profile minimal --component rust-src
rustup default nightly

# Install bpf-linker — required by Aya to link eBPF object files
cargo install bpf-linker

# Verify
rustc --version        # expect nightly
cargo --version
bpf-linker --version   # expect bpf-linker 0.9.x
```

> **`bpf-linker` install time:** This compiles LLVM components and can take 5–15 minutes on first install. It only needs to be done once.

### 3.3 Install build dependencies inside WSL2

```bash
# Inside WSL2
sudo apt-get update
sudo apt-get install -y \
  build-essential \
  pkg-config \
  llvm \
  clang \
  libelf-dev \
  iproute2       # provides the `tc` command — useful for manual verification
```

> **Note:** `linux-headers-$(uname -r)` is intentionally omitted. The Microsoft WSL2 kernel (`*-microsoft-standard-WSL2`) has no matching headers package in Ubuntu's repos, and Aya does not need them — the eBPF crate compiles to `bpfel-unknown-none` using `build-std=core` with Aya's own type definitions, not system kernel headers.

### 3.4 Configure Docker Desktop for WSL2

1. Open **Docker Desktop → Settings → Resources → WSL Integration**
2. Enable integration for your Ubuntu distro
3. Click **Apply & Restart**
4. **Close and reopen your WSL2 terminal.** Docker Desktop injects the socket path at session start — an existing terminal will not pick up the change.

### 3.5 Install `kind` inside WSL2

Docker Desktop does **not** ship `kind`. Install it manually inside WSL2:

```bash
# Inside WSL2
curl -Lo /tmp/kind https://kind.sigs.k8s.io/dl/v0.22.0/kind-linux-amd64
chmod +x /tmp/kind
sudo mv /tmp/kind /usr/local/bin/kind
kind version   # expect: kind v0.22.x
```

> `kubectl` was already confirmed working (`v1.34.1`). If it ever goes missing inside WSL2, install it via: `sudo snap install kubectl --classic`

Verify all three tools work:
```bash
# Inside WSL2 (in a freshly opened terminal)
docker ps          # should list containers (or empty table), no permission error
kind version       # expect v0.22.x
kubectl version --client
```

---

## 4. Step 1 — Spin Up the Local Kubernetes Cluster

Run the setup script from inside WSL2. The script creates the kind cluster, waits for nodes to be Ready, and deploys the test pods.

```bash
# Inside WSL2 — from the repo root
cd /mnt/d/Projects/MeshLite

chmod +x hack/dev-cluster.sh hack/teardown.sh
./hack/dev-cluster.sh
```

**Expected output (abridged):**
```
[dev-cluster] Creating kind cluster 'meshlite-dev' (1 control-plane + 2 workers)...
[dev-cluster] Cluster created.
[dev-cluster] Waiting for all nodes to reach Ready state...
[dev-cluster] Deploying Phase 1 test services (service-alpha, service-beta)...
[dev-cluster] Waiting for test pods to be Running...
[dev-cluster] Setup complete. Active context: kind-meshlite-dev
```

**Verify manually:**
```bash
kubectl get nodes
# Expected:
# NAME                         STATUS   ROLES           AGE   VERSION
# meshlite-dev-control-plane   Ready    control-plane   2m    v1.x.x
# meshlite-dev-worker          Ready    <none>          2m    v1.x.x
# meshlite-dev-worker2         Ready    <none>          2m    v1.x.x

kubectl get pods -n meshlite-test
# Expected:
# NAME                             READY   STATUS    RESTARTS
# service-alpha-xxxxx              1/1     Running   0
# service-beta-xxxxx               1/1     Running   0
```

---

## 5. Step 2 — Build the eBPF Program

This must be done inside WSL2 because it compiles to `bpfel-unknown-none` (Linux BPF byte code).

```bash
# Inside WSL2
cd /mnt/d/Projects/MeshLite/kprobe/kprobe-ebpf

cargo +nightly build \
  --target bpfel-unknown-none \
  -Z build-std=core \
  --release
```

**Expected output:**
```
   Compiling kprobe-ebpf v0.1.0
    Finished `release` profile [optimized] target(s) in Xs
```

The compiled eBPF object will be at:
```
kprobe/target/bpfel-unknown-none/release/kprobe-ebpf
```

> **Why `release`?** The eBPF verifier rejects programs with stack frames over 512 bytes. Release mode enables optimisations that reduce stack usage. Always build the eBPF crate in release mode for loading into the kernel.

---

## 6. Step 3 — Build the Userspace Loader

```bash
# Inside WSL2
cd /mnt/d/Projects/MeshLite/kprobe/kprobe-userspace

cargo +nightly build \
  --target x86_64-unknown-linux-gnu \
  --release
```

**Expected output:**
```
   Compiling kprobe-userspace v0.1.0
    Finished `release` profile [optimized] target(s) in Xs
```

Binary location:
```
kprobe/target/x86_64-unknown-linux-gnu/release/kprobe-loader
```

---

## 7. Step 4 — Deploy the Userspace Loader as a DaemonSet

The userspace loader (`kprobe-loader`) must run on the Kubernetes node itself — it needs `CAP_BPF` and `CAP_NET_ADMIN` to load eBPF programs into the kernel. We run it as a privileged DaemonSet.

### 7.1 Copy the binaries into the kind node

kind nodes are Docker containers. We copy the built binaries directly into the worker nodes.

```bash
# Inside WSL2

EBPF_BIN="/mnt/d/Projects/MeshLite/kprobe/target/bpfel-unknown-none/release/kprobe-ebpf"
LOADER_BIN="/mnt/d/Projects/MeshLite/kprobe/target/x86_64-unknown-linux-gnu/release/kprobe-loader"

# Copy to both worker nodes
for NODE in meshlite-dev-worker meshlite-dev-worker2; do
  echo "Copying to $NODE..."
  docker cp "$EBPF_BIN" "${NODE}:/opt/kprobe-ebpf"
  docker cp "$LOADER_BIN" "${NODE}:/opt/kprobe-loader"
  docker exec "${NODE}" chmod +x /opt/kprobe-loader
done

echo "Binaries deployed."
```

### 7.2 Run the loader manually (Phase 1 style — no Helm yet)

You need two WSL2 terminal windows. **Both terminals are WSL2** — not PowerShell, not Windows Terminal running cmd. Open a second Ubuntu/WSL2 tab or window before continuing.

**Terminal 1 — Start the loader on a worker node:**
```bash
# In WSL2 Terminal 1: exec into the worker node as root
docker exec -it meshlite-dev-worker bash

# You are now inside the kind worker container (prompt changes to root@meshlite-dev-worker)
# Pipe through grep to filter out background kubelet traffic (172.18.x.x → API server)
# and show only pod-to-pod packets (pod CIDR is 10.244.x.x)
RUST_LOG=info /opt/kprobe-loader eth0 /opt/kprobe-ebpf 2>&1 | grep --line-buffered "10\.244\."
```

> Without the `grep` filter, the loader will continuously print kubelet heartbeat lines (`172.18.x.x → 172.18.x.x:6443`) which are background Kubernetes control-plane traffic. The `grep` passes through only pod CIDR addresses, making pod-to-pod interception events easy to spot.

**Expected output in Terminal 1:**
```
[kprobe] Loading eBPF object from: /opt/kprobe-ebpf
[kprobe] Attaching to interface:   eth0
WARN  kprobe_loader] [kprobe] eBPF logger unavailable (non-fatal): log event array AYA_LOGS doesn't exist
[kprobe] eBPF program loaded on eth0 — intercepting pod-to-pod traffic
[kprobe] Listening — press Ctrl+C to stop and unload eBPF program
[INTERCEPT] src=172.18.0.2:XXXXX dst=172.18.0.4:6443 proto=TCP   ← background k8s traffic (normal)
[INTERCEPT] src=172.18.0.2:XXXXX dst=172.18.0.4:6443 proto=TCP
```

> **`AYA_LOGS` warning** is non-fatal — it means the eBPF program does not expose an optional kernel-side logging map. Packet interception works regardless.
>
> **Background `[INTERCEPT]` lines** will appear immediately. `172.18.0.4:6443` is the Kubernetes API server on the kind control-plane container. `172.18.0.2` is this worker node. These are kubelet heartbeats — the eBPF hook is correctly intercepting all egress traffic on `eth0`.

---

## 8. Test 1.A — Does the eBPF Hook Fire?

**Terminal 2 — Generate traffic between the test pods:**
```bash
# In WSL2 Terminal 2 (a NEW WSL2 window — NOT inside the kind node, NOT PowerShell)
# kubectl is installed in WSL2, so all kubectl commands run from WSL2
kubectl exec -it deploy/service-alpha -n meshlite-test -- wget -qO- http://service-beta:8080
```

**Expected output in Terminal 1 (the loader):**

If the two pods are scheduled on **different worker nodes**, the egress packet crosses `eth0` and you will see:
```
[INTERCEPT] src=10.244.1.5:43210 dst=10.244.2.7:8080 proto=TCP
```

If both pods are scheduled on the **same worker node**, the traffic stays on the local CNI bridge and does NOT cross `eth0`. In that case, new `[INTERCEPT]` lines will not appear for the curl — but the background kubelet lines will continue. You can verify where the pods are scheduled:
```bash
# In WSL2 Terminal 2
kubectl get pods -n meshlite-test -o wide
# Check the NODE column — if both show meshlite-dev-worker, attach to their veth instead (see Troubleshooting)
```

**What this verifies:**
The eBPF program fires on egress, extracts the 4-tuple (src IP, dst IP, src port, dst port) and protocol from the packet, writes it to the perf event ring buffer, and the userspace loader reads and prints it.

---

## 9. Test 1.B — Interception Does Not Break Connectivity

Run 100 sequential requests while the eBPF program is loaded:

```bash
# busybox wget: -s is not supported; use -q (quiet) and check exit code via response content
kubectl exec -it deploy/service-alpha -n meshlite-test -- \
  sh -c 'for i in $(seq 1 100); do wget -qO- http://service-beta:8080 > /dev/null && echo 200 || echo FAIL; done'
```

**Expected output:** 100 lines of `200`.

**What this verifies:** Returning `TC_ACT_OK` passes packets through without corruption. Zero failures here means the passthrough path is working.

**Acceptance criterion:** 0 failures out of 100 requests.

---

## 10. Test 1.C — Pod Traffic Only, Not Host Traffic

This test verifies that you can distinguish node-sourced traffic from pod-sourced traffic by source IP.

> **Why the loader shows background logs without any curl/wget:** The TC hook on `eth0` intercepts ALL egress traffic on that interface — including kubelet heartbeats (`172.18.x.x → 172.18.x.x:6443`). This is expected Phase 1 behaviour; the grep filter added in §7.2 hides that noise. For this test only, run the loader unfiltered so node traffic is visible.

**Step 1 — In Terminal 1, restart the loader WITHOUT the grep filter:**
```bash
# Ctrl+C the current loader, then restart unfiltered
RUST_LOG=info /opt/kprobe-loader eth0 /opt/kprobe-ebpf
```
You will immediately see background kubelet lines — that's fine.

**Step 2 — Get the ClusterIP from WSL2 Terminal 2:**
```bash
# In WSL2 Terminal 2 (outside the kind node — the andre@Andrew prompt)
kubectl get svc service-beta -n meshlite-test -o jsonpath='{.spec.clusterIP}'
# Example output: 10.96.45.123  ← copy this value
```

> **ClusterIPs are only routable from inside the cluster.** Do NOT run wget for this step from WSL2 (`andre@Andrew` prompt) — it will hang. The next step execs into the kind node first.

**Step 3 — Make the request from inside the kind node:**
```bash
# In WSL2 Terminal 2: open a shell inside the worker node
docker exec -it meshlite-dev-worker bash

# Now you are root@meshlite-dev-worker — inside the cluster network
# kind nodes don't have curl or wget; use bash's built-in /dev/tcp instead
bash -c 'echo -e "GET / HTTP/1.0\r\nHost: 10.96.45.123\r\n\r\n" > /dev/tcp/10.96.45.123/8080' && echo "connection OK"
# replace 10.96.45.123 with your actual ClusterIP from Step 2
```

**Expected in Terminal 1:** A new `[INTERCEPT]` line appears whose source IP is `172.18.x.x` (the node's IP), not `10.244.x.x` (a pod IP). This confirms the hook sees node traffic differently from pod traffic.

> If the loader output is too noisy to spot, temporarily filter for `172.18.` instead:
> ```bash
> RUST_LOG=info /opt/kprobe-loader eth0 /opt/kprobe-ebpf 2>&1 | grep --line-buffered "172\.18\."
> ```
> Run the bash request again — exactly one new line appears per request, confirming node-sourced interception.

After this test, restart the loader with the pod-CIDR filter for the remaining tests:
```bash
RUST_LOG=info /opt/kprobe-loader eth0 /opt/kprobe-ebpf 2>&1 | grep --line-buffered "10\.244\."
```

---

## 11. Test 1.D — Performance Baseline

This is the most important measurement in Phase 1. You must record it before adding any more logic — it is your comparison point for every future phase.

> **Note on tooling:** `hey` cannot be installed in busybox pods (busybox `wget` lacks the TLS support needed to fetch from S3). We use a timed `wget` loop instead. `time` gives total wall-clock duration; dividing by request count yields average latency per request, which is sufficient to detect the < 0.5ms overhead threshold at Phase 1 scale.

### 11.1 Baseline — WITHOUT Kprobe loaded

Stop the loader first (Ctrl+C in Terminal 1 — this also unloads the eBPF program from the kernel).

Then in WSL2 Terminal 2:
```bash
time kubectl exec -it deploy/service-alpha -n meshlite-test -- \
  sh -c 'for i in $(seq 1 500); do wget -qO- http://service-beta:8080 > /dev/null; done'
```

**Record the `real` time from the output.** Example:
```
real    0m2.847s
user    0m0.201s
sys     0m0.044s
```
Average latency per request = real_time_ms / 500. In this example: 2847ms / 500 = **~5.7ms avg baseline**.

### 11.2 With Kprobe loaded

Restart the loader in Terminal 1:
```bash
RUST_LOG=info /opt/kprobe-loader eth0 /opt/kprobe-ebpf 2>&1 | grep --line-buffered "10\.244\."
```

Then immediately in Terminal 2, run the same loop:
```bash
time kubectl exec -it deploy/service-alpha -n meshlite-test -- \
  sh -c 'for i in $(seq 1 500); do wget -qO- http://service-beta:8080 > /dev/null; done'
```

**Record the `real` time again** and compute average latency per request the same way.

### 11.3 Interpreting results

Subtract the two averages:
```
overhead_per_request_ms = (with_kprobe_real_ms / 500) - (baseline_real_ms / 500)
```

**Acceptance criterion:** overhead must be **under 0.5ms** per request.

> If overhead exceeds 0.5ms, check whether the Tokio perf event reader tasks are keeping up with the ring buffer, or whether the per-CPU buffer size needs tuning before proceeding to Phase 2.

---

## 12. Phase 1 Exit Criteria Checklist

Work through these in order. Do not proceed to Phase 2 until all boxes are checked.

```
[ ] eBPF program compiles without verifier rejection
    → cargo build --target bpfel-unknown-none -Z build-std=core --release
       exits 0 with no errors

[ ] Every pod-to-pod TCP packet is intercepted and logged in userspace
    → Test 1.A: [INTERCEPT] lines appear in loader output when wget runs

[ ] 100 sequential requests return HTTP 200 with eBPF loaded
    → Test 1.B: all 100 lines print "200", zero failures

[ ] p99 latency overhead from interception is under 0.5ms
    → Test 1.D: p99(with kprobe) - p99(baseline) < 0.5ms

[ ] Kprobe loader runs as a privileged process without crashing
    → Loader runs for > 5 minutes with sustained traffic without dying

[ ] Unloading the eBPF program leaves the cluster network functional
    → After Ctrl+C on the loader, curl between the pods still returns 200
```

---

## 13. Teardown

Stop the loader (Ctrl+C in Terminal 1), then from WSL2:

```bash
cd /mnt/d/Projects/MeshLite
./hack/teardown.sh
```

To also remove the cross-cluster pair (if created):
```bash
./hack/teardown.sh --all
```

**Verify:**
```bash
kind get clusters   # should be empty
docker ps           # no meshlite-dev containers
```

---

## 14. Troubleshooting

### eBPF verifier rejects the program

```
Error: failed to load BPF program: Permission denied / invalid program
```

- Ensure you are running the loader as `root` inside the kind node
- Ensure you built the eBPF crate with `--release` (debug builds often exceed the 512-byte stack limit)
- Check the kernel version: `uname -r` must be 5.15+

### `bpf-linker` not found

```
error: linker `bpf-linker` not found
  = note: No such file or directory (os error 2)
```

`bpf-linker` is not part of the Rust toolchain and must be installed separately inside WSL2:

```bash
cargo install bpf-linker
```

This compiles LLVM components and may take 5–15 minutes. After it finishes, re-run the `cargo build` command from Step 2.

### `clsact` qdisc error

```
Error: Failed to add clsact qdisc: file exists (os error 17)
```

This is not an error — the loader handles it. OS error 17 is `EEXIST`, meaning the qdisc is already present from a previous run. The loader logs `clsact qdisc already present` and continues.

### No `[INTERCEPT]` lines appear

1. Check that the interface name is correct: run `ip link show` inside the node and look for the interface with a `10.244.x.x` address
2. Confirm the traffic is actually going through the node where the loader is running — in a multi-node cluster the pod may be scheduled on the other worker
3. Check `RUST_LOG=debug` for more detail from the loader

### API server unreachable after `dev-cluster.sh` (connection reset by peer)

```
error: Get "https://127.0.0.1:XXXXX/api/v1/nodes": read tcp ...: connection reset by peer
```

The cluster name exists in kind's registry but the control plane container is crashed or unreachable (stale state from a previous session). The script skips recreation because it sees the cluster name. Delete and recreate:

```bash
kind delete cluster --name meshlite-dev
./hack/dev-cluster.sh
```

If `meshlite-dev-*` containers are still listed in `docker ps -a` after the delete, force-remove them first:

```bash
docker rm -f meshlite-dev-control-plane meshlite-dev-worker meshlite-dev-worker2
kind delete cluster --name meshlite-dev
./hack/dev-cluster.sh
```

### kind cluster fails to create

```
ERROR: failed to create cluster: ... node(s) didn't reach the Ready state
```

- Increase Docker Desktop memory to 6 GB (Settings → Resources → Memory)
- Run `docker system prune` to free disk space
- Try `kind delete cluster --name meshlite-dev` and re-run `dev-cluster.sh`

### WSL2 and Docker Desktop not integrated

```bash
# Inside WSL2
docker ps   # returns: Cannot connect to the Docker daemon
# or
docker ps   # returns: permission denied while trying to connect to the Docker API
```

- Open Docker Desktop → Settings → Resources → WSL Integration
- Enable the toggle for your Ubuntu distro
- Apply & Restart Docker Desktop
- **Close and reopen your WSL2 terminal** — the socket is only injected at session start
- If the error persists after reopening the terminal, run `wsl --shutdown` in PowerShell, reopen WSL2, and try again

---

*Runbook covers Phase 1 only. Phase 2 (Sigil CA + control plane) begins after all exit criteria above are satisfied.*
