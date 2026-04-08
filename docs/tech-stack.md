# MeshLite — Tech Stack Decision Reference

> **Purpose:** This document exists so any engineer joining the project understands *why* each technology was chosen — not just what was chosen. Every decision here was made after weighing real alternatives. This is not a "we used what we knew" document.
>
> **Components covered:** Sigil · Kprobe · Conduit · Trace · meshctl · Wire Protocol · Data Storage

---

## Table of Contents

1. [How to Read This Document](#1-how-to-read-this-document)
2. [Kprobe — eBPF Runtime Language](#2-kprobe--ebpf-runtime-language)
3. [Sigil — Control Plane Language](#3-sigil--control-plane-language)
4. [Conduit — Gateway Language](#4-conduit--gateway-language)
5. [Trace — Observability Backend](#5-trace--observability-backend)
6. [Trace — Dashboard Frontend](#6-trace--dashboard-frontend)
7. [Wire Protocol — Sigil to Agents](#7-wire-protocol--sigil-to-agents)
8. [TLS Library](#8-tls-library)
9. [Certificate Format and Identity Standard](#9-certificate-format-and-identity-standard)
10. [Data Storage — Sigil State](#10-data-storage--sigil-state)
11. [Kubernetes Integration](#11-kubernetes-integration)
12. [meshctl — CLI Framework](#12-meshctl--cli-framework)
13. [Final Stack Summary](#13-final-stack-summary)

---

## 1. How to Read This Document

Each section follows the same structure:

- **The decision** — what needed to be chosen
- **Options considered** — realistic alternatives with honest pros and cons
- **Decision** — what we chose and the single most important reason why

Scores are given across four dimensions that matter most for infrastructure tooling:

| Dimension | What it means |
|---|---|
| **Performance** | Latency, memory footprint, CPU cost at scale |
| **Reliability** | Maturity, production track record, known failure modes |
| **Developer Velocity** | How fast can the team actually build with this |
| **Operational Fit** | Does it match the constraints of kernel-level, long-running infrastructure |

---

## 2. Kprobe — eBPF Runtime Language

### The decision
Kprobe's eBPF program runs inside the Linux kernel. The kernel imposes strict constraints: no dynamic memory allocation, no unbounded loops, a verifier that rejects unsafe programs before they load. The language choice here is constrained — only a few options are practical.

The userspace component of Kprobe (the part that loads the eBPF program, manages the CertStore, PolicyCache, and Sigil client) is a separate sub-decision covered in section 4.

---

### Option A — Rust + Aya

> Aya is a pure-Rust eBPF library. Both the eBPF program (kernel side) and the userspace loader run in Rust with shared types.

| Dimension | Score | Notes |
|---|---|---|
| Performance | ⭐⭐⭐⭐⭐ | Zero runtime overhead. Compiled to eBPF bytecode directly. Same binary output as C |
| Reliability | ⭐⭐⭐⭐ | Younger than libbpf but production-used at Cloudflare, Datadog. Growing fast |
| Developer Velocity | ⭐⭐⭐⭐ | Single language for both kernel and userspace. Shared types eliminate a whole class of bugs |
| Operational Fit | ⭐⭐⭐⭐⭐ | Rust's ownership model prevents memory bugs in a domain where bugs are catastrophic |

**Pros:**
- One language for kernel and userspace — types are shared, no C/Rust boundary bugs
- Rust's compiler catches memory safety issues before runtime — critical at kernel level
- Aya's async runtime (Tokio) integrates cleanly with the rest of the Rust stack
- No libbpf C dependency — pure Rust compilation pipeline
- Growing ecosystem — Aya is now the default choice for new Rust eBPF projects

**Cons:**
- Aya is younger than libbpf — some advanced eBPF features lag behind
- Smaller community than the C + libbpf path — fewer Stack Overflow answers
- Rust learning curve is steep for engineers unfamiliar with ownership

---

### Option B — C + libbpf

> The original and most widely used approach. eBPF programs written in C, loaded via libbpf from a C or C++ userspace program.

| Dimension | Score | Notes |
|---|---|---|
| Performance | ⭐⭐⭐⭐⭐ | Reference implementation — identical kernel performance to Aya |
| Reliability | ⭐⭐⭐⭐⭐ | Battle-tested. Cilium, Falco, and the Linux kernel tools all use this path |
| Developer Velocity | ⭐⭐⭐ | C is verbose. Manual memory management means slow, careful development |
| Operational Fit | ⭐⭐⭐ | Memory bugs in C kernel code can crash nodes. Requires very experienced C engineers |

**Pros:**
- Most mature path — every eBPF feature is supported on day one
- Largest community, most examples, most documentation
- What Cilium and most major eBPF projects are built on

**Cons:**
- C in kernel context is dangerous — a bad pointer can panic a node
- Two languages (C + whatever userspace is written in) means two build systems, two type systems
- No memory safety guarantees — requires extremely careful engineering discipline

---

### Option C — Go + ebpf-go (Cilium's library)

> Cilium maintains a pure-Go eBPF library. eBPF programs are still written in C but loaded and managed from Go.

| Dimension | Score | Notes |
|---|---|---|
| Performance | ⭐⭐⭐⭐ | Userspace Go overhead is minor. eBPF kernel program performance is identical |
| Reliability | ⭐⭐⭐⭐⭐ | ebpf-go is production-proven — it powers Cilium which runs at massive scale |
| Developer Velocity | ⭐⭐⭐⭐ | Go is fast to write and readable. Cilium's docs are excellent |
| Operational Fit | ⭐⭐⭐ | Split language: C for kernel, Go for userspace. Two build pipelines |

**Pros:**
- ebpf-go is extremely mature — Cilium uses it at production scale in Fortune 500 companies
- Go is faster to develop in than C or Rust for most engineers
- Very good documentation from Cilium team

**Cons:**
- Still requires writing the eBPF program in C — no escaping C for the kernel side
- Go's garbage collector introduces occasional latency spikes — not ideal for a hot path interceptor
- Two language build pipeline adds operational complexity

---

### ✅ Decision — Rust + Aya

> **Primary reason:** Single language for both kernel and userspace eliminates an entire category of bugs that would be especially dangerous at kernel level. Aya is production-proven enough for our requirements and is the future direction of the eBPF ecosystem. Rust's memory safety guarantees matter more here than anywhere else in the stack — a bug in Kprobe runs in the kernel, not in userspace.

---

## 3. Sigil — Control Plane Language

### The decision
Sigil is a long-running server: it watches the Kubernetes API, maintains gRPC streams to every Kprobe agent, acts as a Certificate Authority, and handles cert rotation. It needs to be reliable, handle many concurrent connections, and compile to a small static binary for easy deployment.

---

### Option A — Go

> The dominant language for Kubernetes tooling. The Kubernetes API client (client-go) is native Go. Almost every control plane in the cloud-native ecosystem is Go.

| Dimension | Score | Notes |
|---|---|---|
| Performance | ⭐⭐⭐⭐ | Fast enough for control plane work. GC pauses are a non-issue at this scale |
| Reliability | ⭐⭐⭐⭐⭐ | The entire Kubernetes ecosystem is Go — battle-tested patterns everywhere |
| Developer Velocity | ⭐⭐⭐⭐⭐ | Fastest to build control plane tooling. Enormous library ecosystem |
| Operational Fit | ⭐⭐⭐⭐⭐ | client-go, controller-runtime, gRPC — all first-class in Go |

**Pros:**
- client-go and controller-runtime are the gold standard for K8s API interaction — written for Go
- gRPC has an excellent Go implementation — used by etcd, Kubernetes itself
- Single binary compilation — easy to ship in a container
- Largest talent pool for cloud-native infrastructure work
- Go routines make concurrent gRPC stream management straightforward

**Cons:**
- Garbage collector can introduce short pauses — irrelevant for control plane, would matter for data plane
- Slightly higher memory footprint than Rust for equivalent programs
- Weaker type system than Rust — more runtime errors possible

---

### Option B — Rust

> Consistent with Kprobe. High performance, memory safe, single binary.

| Dimension | Score | Notes |
|---|---|---|
| Performance | ⭐⭐⭐⭐⭐ | Marginally better than Go — irrelevant for a control plane |
| Reliability | ⭐⭐⭐⭐ | Excellent but K8s ecosystem is less mature in Rust |
| Developer Velocity | ⭐⭐⭐ | Slower to build than Go. K8s client libraries less mature |
| Operational Fit | ⭐⭐⭐ | kube-rs exists but is not as mature as client-go |

**Pros:**
- Consistent language with Kprobe — one language across the whole backend
- Memory safety guarantees carry over
- Excellent async story with Tokio

**Cons:**
- kube-rs (K8s client for Rust) is less mature than client-go — more rough edges
- Slower development velocity for server-side code
- Performance advantage over Go is negligible for a control plane that isn't on the hot path

---

### Option C — Java / Kotlin

> Used by some enterprise tooling (e.g. Quarkus-based operators).

| Dimension | Score | Notes |
|---|---|---|
| Performance | ⭐⭐⭐ | JVM startup time is a real problem for a K8s pod |
| Reliability | ⭐⭐⭐⭐ | Very mature platform |
| Developer Velocity | ⭐⭐⭐ | Verbose. Not the right fit for infrastructure tooling |
| Operational Fit | ⭐⭐ | Heavy JVM footprint contradicts MeshLite's lightweight positioning |

**Cons:**
- JVM memory footprint would make Sigil heavier than all of Istio combined — directly contradicts our positioning
- Not what the cloud-native ecosystem expects

---

### ✅ Decision — Go

> **Primary reason:** The Kubernetes control plane ecosystem is built for Go. client-go and controller-runtime handle the complex parts of watching K8s API state — using Go means we are working with the grain of the ecosystem, not against it. The performance difference with Rust is irrelevant for a control plane that is never on the per-request hot path.

---

## 4. Conduit — Gateway Language

### The decision
Conduit sits on the hot path — every cross-cluster request passes through it. It handles TLS termination, policy enforcement, and traffic routing. Low latency and high throughput matter here.

---

### Option A — Rust + Tokio

> Async Rust with Tokio runtime. The same language as Kprobe's userspace component.

| Dimension | Score | Notes |
|---|---|---|
| Performance | ⭐⭐⭐⭐⭐ | No GC pauses. Predictable latency. Linkerd's proxy is written in Rust for this reason |
| Reliability | ⭐⭐⭐⭐⭐ | Memory safe. Production-proven — Linkerd's data plane is Rust |
| Developer Velocity | ⭐⭐⭐ | Slower to write than Go — async Rust has a steep curve |
| Operational Fit | ⭐⭐⭐⭐⭐ | Consistent with Kprobe — shared TLS and cert handling code |

**Pros:**
- No garbage collector — zero GC-induced latency spikes on the request path
- Linkerd proved this works in production — their Rust proxy handles billions of requests
- Consistent with Kprobe — TLS engine, CertStore, and Sigil client code can be shared as a Rust library
- Predictable memory usage — important for a gateway that must stay stable under load

**Cons:**
- Async Rust is genuinely difficult — `async/await` with Tokio has real complexity
- Slower initial development than Go
- Smaller team of engineers who are comfortable with it

---

### Option B — Go

> Consistent with Sigil. Faster to develop. Good enough performance for most cases.

| Dimension | Score | Notes |
|---|---|---|
| Performance | ⭐⭐⭐⭐ | Very good — but GC pauses at p99 are a real concern for a latency-sensitive gateway |
| Reliability | ⭐⭐⭐⭐⭐ | Extremely mature |
| Developer Velocity | ⭐⭐⭐⭐⭐ | Fastest to build |
| Operational Fit | ⭐⭐⭐⭐ | Works well but splits language from Kprobe |

**Pros:**
- Same language as Sigil — engineers can move between components
- Faster development
- Excellent gRPC support

**Cons:**
- GC pauses at p99 can add 1–5ms unexpectedly — for a gateway, this shows up in latency percentiles
- Cannot share TLS/cert code with Kprobe (Rust) — code duplication
- Envoy (also not Go) already owns the space for high-performance proxies

---

### Option C — Envoy (existing proxy, configured not coded)

> Use the existing Envoy proxy as the gateway instead of writing one.

| Dimension | Score | Notes |
|---|---|---|
| Performance | ⭐⭐⭐⭐⭐ | Envoy is one of the highest-performance proxies in existence |
| Reliability | ⭐⭐⭐⭐⭐ | Powers Istio, AWS App Mesh, Google Cloud Traffic Director |
| Developer Velocity | ⭐⭐ | Configuration via xDS API is complex — we are back to Istio-territory complexity |
| Operational Fit | ⭐⭐ | Large binary, complex config — contradicts MeshLite's simplicity story |

**Pros:**
- Extremely battle-tested
- No code to write for the proxy itself

**Cons:**
- Configuring Envoy via xDS is the exact complexity we are promising to eliminate
- Envoy binary is large — adds significant container image size
- We lose control over the TLS implementation — cannot integrate our cert model cleanly

---

### ✅ Decision — Rust + Tokio

> **Primary reason:** Conduit is on the request hot path. GC pauses from Go would show up at p99 latency, which is exactly what users look at in Trace dashboards. More importantly, writing Conduit in Rust means the TLS engine and CertStore logic can be a shared Rust library used by both Kprobe and Conduit — one implementation, two consumers, zero duplication. Linkerd's data plane proved this architecture works at production scale.

---

## 5. Trace — Observability Backend

### The decision
Trace receives a high-volume stream of TelemetryRecords from every Kprobe agent and Conduit gateway, aggregates them, and serves both a dashboard and a Prometheus-compatible `/metrics` endpoint.

---

### Option A — Go

> Write a lightweight custom aggregator in Go. Expose Prometheus metrics directly.

| Dimension | Score | Notes |
|---|---|---|
| Performance | ⭐⭐⭐⭐ | More than sufficient for aggregation workloads |
| Reliability | ⭐⭐⭐⭐ | Straightforward server-side Go |
| Developer Velocity | ⭐⭐⭐⭐⭐ | Fast to build. prometheus/client_golang is excellent |
| Operational Fit | ⭐⭐⭐⭐⭐ | Consistent with Sigil — one backend language |

**Pros:**
- Consistent with Sigil — engineers work in one language for both control plane and observability
- prometheus/client_golang makes Prometheus export trivial
- Easy to keep lightweight — exactly what we want

**Cons:**
- We are writing custom aggregation logic that existing tools already handle well

---

### Option B — Victoria Metrics (embedded)

> Embed VictoriaMetrics as a library inside the Trace binary — get a full time-series DB with no external dependency.

| Dimension | Score | Notes |
|---|---|---|
| Performance | ⭐⭐⭐⭐⭐ | VictoriaMetrics is faster than Prometheus for ingestion |
| Reliability | ⭐⭐⭐⭐ | Production-proven but adds dependency weight |
| Developer Velocity | ⭐⭐⭐ | More complex to integrate |
| Operational Fit | ⭐⭐⭐ | Heavier than we need for v1 |

**Pros:**
- Persistent storage out of the box
- High ingestion performance
- PromQL compatible

**Cons:**
- Over-engineered for v1 — most teams already have Prometheus
- Adds significant binary size and complexity
- We become responsible for a time-series database, not just a metrics aggregator

---

### Option C — OpenTelemetry Collector

> Receive metrics in OpenTelemetry format and let the collector handle export to any backend.

| Dimension | Score | Notes |
|---|---|---|
| Performance | ⭐⭐⭐⭐ | Good — the collector is designed for high throughput |
| Reliability | ⭐⭐⭐⭐⭐ | CNCF project — extremely well supported |
| Developer Velocity | ⭐⭐⭐⭐ | Reduces custom code significantly |
| Operational Fit | ⭐⭐⭐⭐ | Future-proofs export format |

**Pros:**
- Vendor neutral — works with Prometheus, Datadog, Grafana, Jaeger, everything
- Industry standard — teams already know it
- Reduces the amount of export code we write ourselves

**Cons:**
- Another moving part for the user to understand
- Less control over the exact data model and dashboard experience
- For v1, the simplicity of a custom Go aggregator wins

---

### ✅ Decision — Go (custom lightweight aggregator)

> **Primary reason:** For v1, we need something we fully control and that stays lightweight. A custom Go aggregator with prometheus/client_golang gives us exactly what we need — receive TelemetryRecords, aggregate into gauges and histograms, expose `/metrics`. Consistent with Sigil means one backend language for the whole control plane side. OpenTelemetry compatibility is worth adding in v2 once the core is stable.

---

## 6. Trace — Dashboard Frontend

### The decision
The Trace UI needs to show a live service graph, latency histograms, and error rates. It must be embeddable into a single Go binary for easy distribution.

---

### Option A — React + TypeScript

> Industry standard frontend stack. Served as static files embedded in the Go binary.

| Dimension | Score | Notes |
|---|---|---|
| Performance | ⭐⭐⭐⭐ | Fine for a dashboard — no performance concerns |
| Reliability | ⭐⭐⭐⭐⭐ | Most widely used frontend stack in the world |
| Developer Velocity | ⭐⭐⭐⭐⭐ | Largest ecosystem, most component libraries |
| Operational Fit | ⭐⭐⭐⭐⭐ | Static files served from the Go binary via embed — clean distribution |

**Pros:**
- Most engineers know React — easiest to hire for and contribute to
- D3.js and Recharts make service graph visualisation straightforward
- TypeScript catches UI bugs at compile time
- Static build embedded in the Go binary — no separate frontend server to run

**Cons:**
- Bundle size can grow — needs discipline to keep lean
- JavaScript fatigue — rapid ecosystem churn

---

### Option B — Vue.js

> Lighter than React. Gentler learning curve.

| Dimension | Score | Notes |
|---|---|---|
| Performance | ⭐⭐⭐⭐ | Similar to React for this use case |
| Reliability | ⭐⭐⭐⭐ | Mature and stable |
| Developer Velocity | ⭐⭐⭐⭐ | Faster to learn than React but smaller ecosystem |
| Operational Fit | ⭐⭐⭐⭐ | Works the same way as React for embedded distribution |

**Pros:**
- Easier onboarding
- Smaller bundle by default

**Cons:**
- Smaller ecosystem than React
- Fewer infrastructure dashboard component libraries

---

### Option C — Grafana (direct integration, no custom UI)

> Instead of building a dashboard, push metrics to Grafana and link out to it from meshctl.

| Dimension | Score | Notes |
|---|---|---|
| Performance | ⭐⭐⭐⭐⭐ | Grafana is battle-tested at massive scale |
| Reliability | ⭐⭐⭐⭐⭐ | Industry standard |
| Developer Velocity | ⭐⭐⭐⭐⭐ | No frontend code to write at all |
| Operational Fit | ⭐⭐⭐ | Requires user to have Grafana — not self-contained |

**Pros:**
- Zero frontend development cost
- Grafana is already what most teams use
- We ship dashboard JSON configs instead of a UI

**Cons:**
- Requires Grafana to be installed — free tier experience is degraded
- We lose the MeshLite-specific service graph view that makes Trace distinctive
- Grafana is a competitor in the Pro/Enterprise observability space

---

### ✅ Decision — React + TypeScript

> **Primary reason:** The dashboard is a paid-tier differentiator — it needs to feel like a MeshLite product, not a Grafana dashboard we didn't build. React gives us the ecosystem to build the service graph and latency views we need, and the static build embeds cleanly into the Go binary. Grafana export is still supported at the `/metrics` endpoint — teams who want Grafana can have it alongside the native dashboard.

---

## 7. Wire Protocol — Sigil to Agents

### The decision
Sigil maintains a persistent connection to every Kprobe agent and Conduit gateway to push certificates and policy. This protocol needs to be efficient, support streaming, and work well in Kubernetes network conditions.

---

### Option A — gRPC (Protocol Buffers)

| Dimension | Score | Notes |
|---|---|---|
| Performance | ⭐⭐⭐⭐⭐ | Binary protocol — far more efficient than JSON/REST |
| Reliability | ⭐⭐⭐⭐⭐ | Used by Kubernetes itself internally, etcd, and most cloud-native control planes |
| Developer Velocity | ⭐⭐⭐⭐ | Proto definitions generate client + server code automatically |
| Operational Fit | ⭐⭐⭐⭐⭐ | Server-streaming RPCs are exactly the right primitive for cert/policy push |

**Pros:**
- Bidirectional streaming built in — perfect for the Sigil → Kprobe push model
- Protobuf schema is the contract between components — changes are versioned and backward compatible
- Native code generation for both Go (Sigil) and Rust (Kprobe/Conduit)
- Used by every major cloud-native control plane — engineers already know it

**Cons:**
- Binary format is harder to debug with basic tools (need grpcurl or similar)
- More setup than a simple REST API
- Adds protobuf as a build dependency

---

### Option B — REST + JSON (HTTP/2)

| Dimension | Score | Notes |
|---|---|---|
| Performance | ⭐⭐⭐ | JSON parsing overhead adds up at high cert rotation rates |
| Reliability | ⭐⭐⭐⭐ | Simple and well understood |
| Developer Velocity | ⭐⭐⭐⭐⭐ | Easiest to implement and debug |
| Operational Fit | ⭐⭐ | Polling model for cert updates is inefficient. Long-polling is clunky |

**Pros:**
- Every language has a great HTTP client
- Easy to debug with curl

**Cons:**
- No native streaming — polling or long-polling is required for cert push
- JSON is verbose — certificates are large binary blobs that base64-encode poorly
- Not appropriate for a persistent push channel

---

### Option C — NATS / Message Queue

| Dimension | Score | Notes |
|---|---|---|
| Performance | ⭐⭐⭐⭐⭐ | NATS is extremely fast |
| Reliability | ⭐⭐⭐⭐ | NATS is production-proven |
| Developer Velocity | ⭐⭐⭐ | Adds an external dependency (NATS server) |
| Operational Fit | ⭐⭐ | Requires running a broker — another component to operate |

**Cons:**
- Requires a NATS server — now the user must run three things instead of two
- A message broker is the wrong abstraction for a direct control plane push model
- Over-engineered for a point-to-point channel

---

### ✅ Decision — gRPC + Protocol Buffers

> **Primary reason:** gRPC server-streaming RPCs are the exact right primitive for the Sigil push model — Sigil opens one stream per agent and pushes cert bundles and policy updates down it whenever something changes. This is structurally identical to how Kubernetes pushes watch events. Protobuf also gives us versioned, schema-validated messages between Go and Rust — the cross-language boundary is safe by construction.

---

## 8. TLS Library

### The decision
Both Kprobe and Conduit need a TLS 1.3 implementation. This is the most security-critical dependency in the entire stack.

---

### Option A — rustls

> A pure-Rust TLS implementation. No OpenSSL dependency.

| Dimension | Score | Notes |
|---|---|---|
| Performance | ⭐⭐⭐⭐⭐ | Consistently benchmarks faster than OpenSSL for TLS 1.3 |
| Reliability | ⭐⭐⭐⭐⭐ | Audited by ISRG (the people behind Let's Encrypt). Used in production at Cloudflare |
| Developer Velocity | ⭐⭐⭐⭐⭐ | First-class Rust library — integrates naturally |
| Operational Fit | ⭐⭐⭐⭐⭐ | No C FFI. No OpenSSL CVEs to track |

**Pros:**
- Memory safe by construction — no buffer overflow attacks possible in the TLS layer
- No OpenSSL CVEs — the most common source of serious TLS vulnerabilities
- Enforces TLS 1.3 only — older insecure versions are not an option
- ISRG security audit gives confidence for production use
- Pure Rust — no C FFI boundary

**Cons:**
- Does not support some legacy TLS features — irrelevant since we control both ends
- Smaller ecosystem than OpenSSL for advanced configuration

---

### Option B — OpenSSL (via FFI)

| Dimension | Score | Notes |
|---|---|---|
| Performance | ⭐⭐⭐⭐ | Very fast — industry reference |
| Reliability | ⭐⭐⭐ | Reliable but a historically significant CVE source (Heartbleed, etc.) |
| Developer Velocity | ⭐⭐⭐ | C FFI from Rust adds complexity and unsafe blocks |
| Operational Fit | ⭐⭐⭐ | External C dependency complicates static compilation |

**Cons:**
- OpenSSL CVEs are a recurring operational burden — we would be shipping them to users
- C FFI from Rust requires unsafe code — weakens our memory safety story
- Statically linking OpenSSL complicates the build

---

### ✅ Decision — rustls

> **Primary reason:** We are building a security product. The TLS library is the most security-critical dependency we have. rustls gives us memory-safe TLS with no OpenSSL CVE exposure. This is the same choice Cloudflare made when they rewrote their TLS stack. Our users trust us with their service-to-service traffic — this is not the place to accept OpenSSL's historical CVE rate.

---

## 9. Certificate Format and Identity Standard

### The decision
How we represent service identities in certificates — what format, what standard.

---

### Option A — SPIFFE / SVID (x509)

> SPIFFE is a CNCF standard for service identity. An SVID is a SPIFFE Verifiable Identity Document — typically an x509 certificate with a SPIFFE URI in the Subject Alternative Name field.

| Dimension | Score | Notes |
|---|---|---|
| Performance | ⭐⭐⭐⭐⭐ | Standard x509 — no overhead beyond normal TLS |
| Reliability | ⭐⭐⭐⭐⭐ | CNCF standard. Used by Istio, Linkerd, SPIRE |
| Developer Velocity | ⭐⭐⭐⭐ | Well documented. Libraries in Go and Rust |
| Operational Fit | ⭐⭐⭐⭐⭐ | Interoperable — a SPIFFE identity from MeshLite can work with other SPIFFE-aware tools |

**Pros:**
- Industry standard — any SPIFFE-aware tool can verify our identities
- URI format: `spiffe://cluster.local/ns/default/sa/service-a` — human readable and structured
- x509 is natively supported by every TLS implementation
- Future interoperability with HashiCorp Vault, SPIRE, and other identity platforms

**Cons:**
- Slightly more complex than a bare x509 cert — need to parse the SAN URI
- SPIFFE URI format requires discipline to keep consistent across clusters

---

### Option B — Custom x509 with proprietary fields

> Roll our own certificate format using standard x509 but with custom fields for service identity.

**Pros:**
- Full control
- Simpler to implement initially

**Cons:**
- Not interoperable with anything else
- No ecosystem benefit
- We would be reinventing a solved problem

---

### ✅ Decision — SPIFFE / SVID (x509)

> **Primary reason:** SPIFFE is the CNCF standard for exactly this use case. Adopting it means MeshLite identities are interoperable with the broader cloud-native security ecosystem — users are not locked into our CA forever. It also signals to enterprise buyers that we follow open standards, which matters for compliance conversations.

---

## 10. Data Storage — Sigil State

### The decision
Sigil needs to persist its state — issued certificates, enrolled services, compiled policy. What does it use for storage?

---

### Option A — etcd (external)

> The same storage backend that Kubernetes itself uses.

| Dimension | Score | Notes |
|---|---|---|
| Performance | ⭐⭐⭐⭐ | Fast for our access patterns |
| Reliability | ⭐⭐⭐⭐⭐ | Extremely battle-tested — it runs Kubernetes |
| Developer Velocity | ⭐⭐⭐ | Requires running and operating an etcd cluster |
| Operational Fit | ⭐⭐ | Every K8s cluster already has etcd — but users cannot access the cluster's etcd safely |

**Cons:**
- Users cannot use their cluster's existing etcd — we would need our own instance
- Adds operational burden — now users run MeshLite + etcd
- Over-engineered for our access patterns

---

### Option B — SQLite (embedded)

> Embedded relational database. Runs in-process inside Sigil. No external dependency.

| Dimension | Score | Notes |
|---|---|---|
| Performance | ⭐⭐⭐⭐⭐ | For Sigil's write patterns, SQLite is more than sufficient |
| Reliability | ⭐⭐⭐⭐⭐ | SQLite is arguably the most tested software in existence |
| Developer Velocity | ⭐⭐⭐⭐⭐ | Zero operational overhead — it's a file |
| Operational Fit | ⭐⭐⭐⭐⭐ | Single file backup, no external process, trivially embeddable |

**Pros:**
- Zero external dependency — Sigil is a single binary with a single file for state
- Perfectly suited for Sigil's access patterns — mostly reads, infrequent writes on cert rotation
- SQLite's WAL mode handles concurrent reads without blocking
- Trivial backup — copy one file

**Cons:**
- Not suitable for multi-instance Sigil (HA mode) — only one writer at a time
- For Enterprise HA deployments, would need to graduate to Postgres

---

### Option C — Postgres (external)

> Full relational database. Required for proper HA Sigil deployments.

**Pros:**
- Proper multi-writer support for HA
- Rich query capability for audit logs

**Cons:**
- Over-engineered for v1
- Adds an external dependency that contradicts our single-Helm-install story

---

### ✅ Decision — SQLite for v1, Postgres migration path for Enterprise

> **Primary reason:** SQLite lets Sigil be a single binary with no external dependencies — consistent with our "single Helm install" promise. Sigil's write load is low: certs are issued on pod startup and rotated every 24 hours. SQLite handles this trivially. The Enterprise HA path to Postgres is a clean migration — the schema is the same, just the driver changes.

---

## 11. Kubernetes Integration

### The decision
How Sigil watches the Kubernetes API for pod and service lifecycle events.

---

### Option A — controller-runtime (operator SDK)

> The standard Go library for building Kubernetes operators and controllers.

| Dimension | Score | Notes |
|---|---|---|
| Performance | ⭐⭐⭐⭐⭐ | Uses informers with local cache — zero API server hammering |
| Reliability | ⭐⭐⭐⭐⭐ | The standard — used by every K8s operator |
| Developer Velocity | ⭐⭐⭐⭐⭐ | Reconciler pattern is idiomatic and well understood |
| Operational Fit | ⭐⭐⭐⭐⭐ | Handles reconnection, leader election, and cache sync automatically |

**Pros:**
- Informer pattern caches API objects locally — Sigil never hammers the API server
- Reconciliation loop handles all edge cases: missed events, restarts, conflicts
- Leader election built in — necessary for HA Sigil deployment
- The entire K8s operator community uses this pattern — easy to find help

**Cons:**
- Slightly more boilerplate to set up than raw client-go

---

### ✅ Decision — controller-runtime

> **Primary reason:** There is no realistic alternative for a production-grade Kubernetes controller. controller-runtime handles informer caching, leader election, and reconciliation — writing this from scratch with raw client-go would be weeks of work for no benefit.

---

## 12. meshctl — CLI Framework

### The decision
meshctl is the operator-facing CLI. It needs to validate mesh.yaml, apply config to Sigil, inspect live state, and provide a good developer experience.

---

### Option A — Cobra + Viper (Go)

> The standard CLI framework used by kubectl, helm, and nearly every cloud-native CLI tool.

| Dimension | Score | Notes |
|---|---|---|
| Performance | ⭐⭐⭐⭐⭐ | Fast binary, low startup time |
| Reliability | ⭐⭐⭐⭐⭐ | kubectl and helm are both built on Cobra |
| Developer Velocity | ⭐⭐⭐⭐⭐ | Huge ecosystem, excellent documentation |
| Operational Fit | ⭐⭐⭐⭐⭐ | Go single binary — no runtime required |

**Pros:**
- kubectl pattern — operators already know how Cobra CLIs work
- Single static binary — `brew install`, `apt install`, or download and run
- Viper handles config file parsing cleanly
- Shell completion built in

**Cons:**
- None material for a CLI tool

---

### ✅ Decision — Cobra + Viper (Go)

> **Primary reason:** There is no reason to reinvent this. kubectl, helm, and istioctl are all Cobra-based. Operators will use meshctl alongside these tools — consistency in CLI patterns reduces friction. Single Go binary means trivial distribution.

---

## 13. Final Stack Summary

> This is the reference table. Every choice above feeds into this. When someone asks "why are we using X" — the answer is in the sections above. This table is just the quick lookup.

| Component | Technology | Primary Reason |
|---|---|---|
| **Kprobe — eBPF program** | Rust + Aya | Single language for kernel + userspace. Memory safe at kernel level |
| **Kprobe — userspace runtime** | Rust + Tokio | Shares TLS + cert code with Conduit as a shared library |
| **Sigil — control plane** | Go | K8s ecosystem is built for Go. client-go and controller-runtime are best-in-class |
| **Conduit — gateway** | Rust + Tokio | On the request hot path. No GC pauses. Shares TLS library with Kprobe |
| **Trace — backend** | Go | Consistent with Sigil. prometheus/client_golang makes metrics export trivial |
| **Trace — frontend** | React + TypeScript | Largest ecosystem. Static embed in Go binary. Needed for service graph visualisation |
| **Wire protocol** | gRPC + Protobuf | Streaming push model. Cross-language (Go ↔ Rust) with generated type-safe clients |
| **TLS library** | rustls | Memory safe. No OpenSSL CVEs. ISRG-audited. TLS 1.3 only |
| **Certificate standard** | SPIFFE / SVID (x509) | CNCF standard. Interoperable. Future-proof for enterprise identity platforms |
| **Sigil storage (v1)** | SQLite | Zero external dependency. Single binary story. Sufficient for write patterns |
| **Sigil storage (Enterprise)** | Postgres | Multi-writer HA. Same schema — clean migration from SQLite |
| **K8s integration** | controller-runtime | Industry standard operator pattern. Informer caching + leader election built in |
| **meshctl** | Go + Cobra + Viper | Same pattern as kubectl and helm. Single binary distribution |

### Language split — why two languages and not one

The deliberate choice to use **Go for the control plane** and **Rust for the data plane** is worth explaining explicitly because it looks like inconsistency but is actually intentional.

Go wins where developer velocity and ecosystem matter most — Sigil, Trace, and meshctl all interact heavily with the Kubernetes API and benefit from client-go, controller-runtime, and the Go gRPC ecosystem.

Rust wins where performance and memory safety matter most — Kprobe runs inside the Linux kernel where a memory bug can crash a node, and Conduit is on the per-request hot path where GC pauses show up in latency percentiles.

The shared boundary is gRPC + Protobuf — Go and Rust both have excellent gRPC implementations and Protobuf generates type-safe clients in both languages. The split is clean.

This is the same split that the broader cloud-native ecosystem has landed on — Kubernetes itself (Go) runs alongside data plane components like Cilium's eBPF (C/Rust) and Linkerd's proxy (Rust).

---

*End of Tech Stack Decision Reference v0.1*

> **Next document:** MeshLite — Technical Deep Dive  
> Covers the actual implementation: Sigil's CA internals, the Kprobe eBPF program structure in Rust + Aya, Conduit TLS handshake code, and the full bootstrap sequence from `helm install` to first secured request.