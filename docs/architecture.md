# MeshLite — Architecture Documentation

> **Version:** 1.0 — Phase 5 MVP Architecture  
> **Components:** Sigil (Control Plane) · Kprobe (eBPF Enforcer) · Conduit (Gateway) · Trace (Observability Dashboard)

---

## Table of Contents

1. [What MeshLite Is](#1-what-meshlite-is)
2. [Core Design Principles](#2-core-design-principles)
3. [C4 Level 1 — System Context](#3-c4-level-1--system-context)
4. [C4 Level 2 — Container Diagram](#4-c4-level-2--container-diagram)
5. [C4 Level 3 — Component Diagram](#5-c4-level-3--component-diagram)
6. [Class Diagrams](#6-class-diagrams)
7. [Same-Cluster — Request Flow](#7-same-cluster--request-flow)
8. [Cross-Cluster — Request Flow](#8-cross-cluster--request-flow)
9. [Certificate Lifecycle](#9-certificate-lifecycle)
10. [Policy Enforcement Model](#10-policy-enforcement-model)
11. [Observability Architecture](#11-observability-architecture)

---

## 1. What MeshLite Is

MeshLite is a **Zero Trust Networking tool for Kubernetes** that handles the security and observability layer of a service mesh without the operational overhead of running a full mesh like Istio.

It operates at two levels:

- **Kernel level** via Kprobe (eBPF) — for traffic between services inside the same cluster
- **Network boundary level** via Conduit gateways — for traffic crossing between separate clusters

Neither the sending service nor the receiving service changes any code. MeshLite is entirely transparent to application workloads.

---

## 2. Core Design Principles

| Principle | What it means in practice |
|---|---|
| **Zero application change** | Services write and receive plain HTTP. MeshLite handles encryption beneath them |
| **Kernel-first for intra-cluster** | Kprobe (eBPF) intercepts at the kernel tc layer — no sidecar, no extra process per pod |
| **Gateway-first for cross-cluster** | Conduit sits at the cluster edge where eBPF cannot reach |
| **Centralised identity** | Sigil is the single Certificate Authority — all certs flow from here |
| **Declarative config** | One `mesh.yaml` describes the entire security posture |
| **Observability as a byproduct** | Kprobe already sees every packet — metrics collection adds no overhead |

---

## 3. C4 Level 1 — System Context

> **What this shows:** The big picture — who uses MeshLite, what lives inside it, and what external systems it connects to. No internals yet.

### 3.1 Same-Cluster Context

```mermaid
graph LR
    DevOps(["👤 Platform Engineer Writes mesh.yaml Monitors Trace"])
    Dev(["👤 App Developer Deploys services No MeshLite awareness"])

    subgraph ML ["MeshLite"]
        direction TB
        Sigil["Sigil Control Plane"]
        Kprobe["Kprobe eBPF Enforcer"]
        Trace["Trace Dashboard"]
        Sigil -->|pushes certs + policy| Kprobe
        Kprobe -->|sends metrics| Trace
    end

    subgraph K8S ["Kubernetes Cluster"]
        SvcA["Service A"]
        SvcB["Service B"]
        SvcC["Service C"]
    end

    Ext["Prometheus / Grafana External Monitoring"]

    DevOps -->|configures via mesh.yaml| Sigil
    DevOps -->|views| Trace
    Dev -->|deploys to| K8S
    Kprobe -->|intercepts traffic between| K8S
    Trace -->|exports metrics to| Ext
```

---

### 3.2 Cross-Cluster Context

> **Key point:** Sigil lives **inside MeshLite** — it is our control plane, not an external system. Both clusters connect to the same Sigil instance. This shared root is what lets them verify each other's certificates.

```mermaid
graph LR
    DevOps(["👤 Platform Engineer Manages both clusters from one place"])

    subgraph ML ["MeshLite — our product"]
        direction TB
        Sigil["Sigil Single Root CA Issues certs for BOTH clusters"]
        TraceC["Trace Central Unified dashboard for both clusters"]
    end

    subgraph C1 ["Kubernetes Cluster 1  — Team A"]
        direction TB
        KP1["Kprobe eBPF intra-cluster"]
        CE["Conduit Egress Outbound boundary"]
        KP1 -->|hands off cross-cluster traffic| CE
    end

    subgraph C2 ["Kubernetes Cluster 2  — Team B"]
        direction TB
        CI["Conduit Ingress Inbound boundary"]
        KP2["Kprobe eBPF intra-cluster"]
        CI -->|forwards into cluster| KP2
    end

    NET(["Internet / VPN mTLS encrypted"])

    DevOps -->|configures| ML
    Sigil -->|certs + policy| C1
    Sigil -->|certs + policy| C2
    CE -->|encrypted request| NET
    NET -->|encrypted request| CI
    C1 -->|metrics| TraceC
    C2 -->|metrics| TraceC
    DevOps -->|monitors| TraceC
```

---

## 4. C4 Level 2 — Container Diagram

> **What this shows:** The actual deployable units — what runs as a process, where it runs in the cluster, and how the pieces talk to each other.

### 4.1 Same-Cluster — What Runs Where

```mermaid
graph LR
    subgraph CP ["Sigil Deployment — meshlite-system namespace"]
        direction TB
        CA["Certificate Authority Signs service identity certs"]
        PE["Policy Engine Compiles mesh.yaml rules"]
        PD["Policy Distributor gRPC push to agents"]
        CA --> PD
        PE --> PD
    end

    subgraph DS ["Kprobe DaemonSet — one pod per node"]
        direction TB
        EP["eBPF Program Loaded into kernel tc layer"]
        CS["CertStore In-memory cert cache"]
        PC["PolicyCache In-memory policy cache"]
        EP --> CS
        EP --> PC
    end

    subgraph TR ["Trace Deployment — meshlite-system namespace"]
        direction TB
        AGG["Aggregator Collects from all Kprobe agents"]
        UI["Dashboard UI Browser-based"]
        AGG --> UI
    end

    CLI["meshctl CLI tool run by operator"]
    K8sAPI(["Kubernetes API Server"])

    CLI -->|applies mesh.yaml| CP
    PD -->|gRPC stream — certs + policy| DS
    EP -->|metrics stream| AGG
    CP -->|watches pod events| K8sAPI
```

---

### 4.2 Cross-Cluster — What Runs Where

> Sigil runs once — hosted by us or self-hosted (Enterprise). Both clusters connect to it. Conduit runs at the edge of each cluster.

```mermaid
graph LR
    subgraph SIGIL ["Sigil — Hosted Control Plane"]
        direction TB
        SigilCore["Sigil Core Root CA for all clusters"]
        TraceHub["Trace Central Aggregates metrics from all clusters"]
    end

    subgraph C1 ["Cluster 1"]
        direction TB
        KP1["Kprobe DaemonSet — intra-cluster"]
        CE["Conduit Egress Deployment at cluster edge Handles outbound cross-cluster traffic"]
        KP1 -->|routes cross-cluster traffic to| CE
    end

    subgraph C2 ["Cluster 2"]
        direction TB
        CI["Conduit Ingress Deployment at cluster edge Handles inbound cross-cluster traffic"]
        KP2["Kprobe DaemonSet — intra-cluster"]
        CI -->|forwards to destination node| KP2
    end

    NET(["Internet / VPN"])

    SigilCore -->|certs + policy| KP1
    SigilCore -->|certs + policy| KP2
    SigilCore -->|cluster boundary cert| CE
    SigilCore -->|cluster boundary cert| CI
    CE -->|mTLS over internet| NET
    NET -->|mTLS arrives| CI
    KP1 -->|metrics| TraceHub
    KP2 -->|metrics| TraceHub
    CE -->|boundary metrics| TraceHub
    CI -->|boundary metrics| TraceHub
```

---

## 5. C4 Level 3 — Component Diagram

> **What this shows:** The internal sub-components inside each deployable unit. Opening the hood on each container from the previous section.

### 5.1 Inside Sigil

```mermaid
graph LR
    IN(["mesh.yaml from meshctl"])

    subgraph Sigil ["Sigil"]
        direction LR
        API["Sigil API gRPC + REST Entry point"] --> PE
        API --> CA
        PE["Policy Engine Parses allow/deny rules"] --> DIST
        CA["Certificate Authority Root CA — signs certs"] --> DIST
        REG["Service Registry Watches K8s API Maps service → identity"] --> PE
        ROT["Cert Rotator Tracks TTLs Renews before expiry"] --> CA
        ROT --> DIST
        DIST["Policy Distributor gRPC stream per agent Pushes on every change"]
    end

    OUT(["Kprobe agents + Conduit gateways"])

    IN --> API
    DIST --> OUT
```

---

### 5.2 Inside Kprobe

```mermaid
graph LR
    PKT_IN(["Packet arrives from kernel tc hook"])

    subgraph Kprobe ["Kprobe — one per node"]
        direction LR
        EBPF["eBPF Program kernelspace First to see every packet"] --> TLS
        TLS["TLS Engine rustls Handshake + wrap/unwrap"] --> CERT
        TLS --> POL
        CERT["CertStore In-memory service certs + root CA"]
        POL["PolicyCache In-memory O(1) allow/deny lookup"]
        SIGCL["Sigil Client gRPC stream"] --> CERT
        SIGCL --> POL
        TLS --> TEL["Telemetry Emitter async — never blocks request path"]
    end

    PKT_OUT(["Plain HTTP delivered to destination pod"])

    PKT_IN --> EBPF
    TLS --> PKT_OUT
```

---

### 5.3 Inside Conduit

> Conduit Egress and Conduit Ingress are the same binary — direction determines behaviour.

```mermaid
graph LR
    IN_E(["From Kprobe intra-cluster mTLS egress side"])
    IN_I(["From internet cross-cluster mTLS ingress side"])

    subgraph Conduit ["Conduit Gateway"]
        direction LR
        LIST["Listener Accepts both directions"] --> TLS_T
        TLS_T["TLS Terminator Egress: wraps in cross-cluster mTLS Ingress: unwraps + verifies peer cert"] --> CPOL
        CPOL["Policy Enforcer Cross-cluster allow/deny Is Cluster 1 SvcA allowed to call Cluster 2 SvcB?"] --> ROUTE
        ROUTE["Traffic Router Resolves destination node Forwards to correct Kprobe"]
        TLS_T --> CSTORE["Cert Store Cluster boundary cert from Sigil"]
        TLS_T --> CTEL["Telemetry Emitter Boundary metrics"]
    end

    OUT_E(["To internet cross-cluster mTLS"])
    OUT_I(["To Kprobe on destination node"])

    IN_E --> LIST
    IN_I --> LIST
    ROUTE --> OUT_E
    ROUTE --> OUT_I
```

---

## 6. Class Diagrams

### 6.1 Certificate and Identity — Core Domain

```mermaid
classDiagram
    direction LR

    class ServiceIdentity {
        +serviceID : String
        +namespace : String
        +clusterID : String
        +spiffeURI : String
        +toSPIFFE() String
    }

    class Certificate {
        +serialNumber : String
        +issuedAt : DateTime
        +expiresAt : DateTime
        +publicKey : Bytes
        +isExpired() Boolean
    }

    class CertificateBundle {
        +serviceCert : Certificate
        +rootCACert : Certificate
        +nextRotationAt : DateTime
        +isValid() Boolean
    }

    class CertificateAuthority {
        +rootCert : Certificate
        +issueCert(id : ServiceIdentity) Certificate
        +revokeCert(serial : String) void
        +rotateCert(id : ServiceIdentity) Certificate
        +verifyChain(cert : Certificate) Boolean
    }

    class Policy {
        +policyID : String
        +compiledAt : DateTime
        +evaluate(from : ServiceIdentity, to : ServiceIdentity) Decision
    }

    class PolicyRule {
        +from : ServiceIdentity
        +to : List~ServiceIdentity~
        +action : Decision
    }

    class Decision {
        <<enumeration>>
        ALLOW
        DENY
    }

    CertificateAuthority ..> Certificate : creates
    Certificate --> ServiceIdentity : identifies
    CertificateBundle --> Certificate : holds two of
    Policy --> PolicyRule : composed of
    PolicyRule --> Decision : returns
```

---

### 6.2 Kprobe — Packet and Enforcement Model

```mermaid
classDiagram
    direction LR

    class KprobeAgent {
        +nodeID : String
        +intercept(pkt : Packet) void
        +processOutbound(pkt : Packet) void
        +processInbound(pkt : Packet) void
    }

    class Packet {
        +sourceIP : String
        +destIP : String
        +sourcePort : Int
        +destPort : Int
        +direction : Direction
        +rawBytes : Bytes
    }

    class TLSSession {
        +sessionID : String
        +localIdentity : ServiceIdentity
        +peerIdentity : ServiceIdentity
        +state : TLSState
        +wrap(plain : Bytes) Bytes
        +unwrap(cipher : Bytes) Bytes
    }

    class TLSState {
        <<enumeration>>
        HANDSHAKE
        ESTABLISHED
        FAILED
        CLOSED
    }

    class PolicyCache {
        +evaluate(from : ServiceIdentity, to : ServiceIdentity) Decision
        +update(policy : Policy) void
    }

    class CertStore {
        +getBundle(id : ServiceIdentity) CertificateBundle
        +update(bundle : CertificateBundle) void
        +getRootCA() Certificate
    }

    class TelemetryRecord {
        +source : ServiceIdentity
        +destination : ServiceIdentity
        +latencyMs : Int
        +statusCode : Int
        +tlsVerified : Boolean
        +policyAllowed : Boolean
        +timestamp : DateTime
    }

    KprobeAgent --> Packet : intercepts
    KprobeAgent --> TLSSession : creates per connection
    KprobeAgent --> PolicyCache : consults
    KprobeAgent --> CertStore : reads from
    KprobeAgent ..> TelemetryRecord : emits
    TLSSession --> TLSState : tracks
    TLSSession --> CertStore : reads certs from
```

---

### 6.3 MeshConfig — What mesh.yaml Becomes in Code

```mermaid
classDiagram
    direction LR

    class MeshConfig {
        +meshName : String
        +namespace : String
        +validate() ValidationResult
    }

    class ServiceConfig {
        +name : String
        +namespace : String
        +clusterID : String
    }

    class GlobalPolicy {
        +mtls : MTLSMode
        +defaultAllow : Boolean
    }

    class AllowRule {
        +from : String
        +to : List~String~
    }

    class MTLSMode {
        <<enumeration>>
        ENFORCE
        PERMISSIVE
        OFF
    }

    class ObservabilityConfig {
        +export : String
        +latencyBuckets : List~Int~
    }

    MeshConfig --> ServiceConfig : lists services
    MeshConfig --> GlobalPolicy : has one
    MeshConfig --> ObservabilityConfig : has one
    GlobalPolicy --> AllowRule : has many
    GlobalPolicy --> MTLSMode : uses
```

---

## 7. Same-Cluster — Request Flow

### 7.1 Where Kprobe sits in the Linux networking stack

> Before the request flow, understand exactly where Kprobe intercepts. It hooks into the **tc (traffic control) layer** — lower than any sidecar, higher than the physical wire. This is what makes zero-sidecar possible.

```mermaid
graph TB
    APP["Service A writes plain HTTP syscall: write()"]
    SOCK["Linux Socket Layer"]
    TCP["TCP/IP Stack"]
    TC["⚡ tc — Traffic Control Layer Kprobe eBPF program hooks HERE Intercepts every packet before it leaves the kernel Invisible to the application above"]
    NIC["Network Driver / Virtual NIC"]
    WIRE["Physical or Virtual Network"]

    APP --> SOCK --> TCP --> TC --> NIC --> WIRE

    style TC fill:#007F78,color:#fff
```

---

### 7.2 Same-cluster same-node request

> Both services happen to be scheduled on the same Kubernetes node. The entire flow stays inside one kernel.

```mermaid
sequenceDiagram
    actor SA as Service A
    participant KP as Kprobe (Node 1 — kernel tc layer)
    actor SB as Service B

    Note over SA,SB: Both pods on Node 1

    SA->>KP: plain HTTP (egress hook intercepts)

    Note over KP: 1. Resolve source IP → Service A identity
    Note over KP: 2. Resolve dest IP → Service B identity
    Note over KP: 3. PolicyCache.evaluate(A → B) = ALLOW ✅
    Note over KP: 4. TLS wrap (using Service A cert)
    Note over KP: 5. TLS unwrap + verify (Service B cert vs root CA)
    Note over KP: Both certs were issued by Sigil ✅

    KP->>SB: plain HTTP delivered (ingress hook releases)
    Note over KP: 6. Emit TelemetryRecord to Trace (async — after delivery)
```

---

### 7.3 Same-cluster cross-node request

> Services are on different nodes. The packet physically travels across the cluster network — Kprobe on each node handles its own side of the mTLS handshake.

```mermaid
sequenceDiagram
    actor SA as Service A
    participant KP_A as Kprobe (Node 1)
    participant NET as Cluster Network (CNI)
    participant KP_B as Kprobe (Node 2)
    actor SB as Service B

    SA->>KP_A: plain HTTP (egress intercept on Node 1)

    Note over KP_A: Resolve identities, check policy = ALLOW ✅
    Note over KP_A: Prepare TLS 1.3 handshake as Service A

    KP_A->>KP_B: TLS ClientHello + Service A certificate

    Note over KP_B: Verify Service A cert against Sigil root CA ✅

    KP_B->>KP_A: TLS ServerHello + Service B certificate

    Note over KP_A: Verify Service B cert against Sigil root CA ✅

    Note over KP_A,KP_B: Both sides verified each other = mTLS complete ✅

    KP_A->>NET: encrypted payload (TLS record)
    NET->>KP_B: encrypted payload arrives Node 2
    Note over KP_B: Decrypts payload, final policy check
    KP_B->>SB: plain HTTP delivered

    KP_A-->>KP_A: emit egress TelemetryRecord (async)
    KP_B-->>KP_B: emit ingress TelemetryRecord (async)
```

---

### 7.4 Kprobe startup — how it gets its certs and policy

```mermaid
sequenceDiagram
    participant K8s as Kubernetes API
    participant Sigil as Sigil
    participant KP as Kprobe (new node)

    KP->>Sigil: gRPC connect (NodeID, ClusterID)
    Sigil->>K8s: list pods scheduled on this node
    K8s->>Sigil: [Service A, Service B, Service C ...]

    loop For each service on this node
        Note over Sigil: Issue x509 cert for this service identity
        Sigil->>KP: push CertificateBundle (service cert + root CA)
    end

    Sigil->>KP: push compiled Policy
    KP->>KP: load eBPF program into kernel tc layer
    KP->>KP: populate CertStore + PolicyCache in memory
    KP->>Sigil: ACK — ready to enforce

    Note over KP: Intercepting all traffic on this node from this point

    loop Every 23h — proactive rotation before 24h TTL expires
        Sigil->>KP: push rotated CertificateBundle
        KP->>KP: atomically swap CertStore entry
        Note over KP: Old cert stays valid during swap — zero downtime
    end
```

---

## 8. Cross-Cluster — Request Flow

### 8.1 Why eBPF stops at the cluster boundary

> eBPF runs inside a specific kernel on a specific node. Once a packet leaves that cluster and travels the internet to another cluster, there is no eBPF instance that can intercept it. Conduit is the bridge.

```mermaid
graph LR
    subgraph C1 ["Cluster 1"]
        SA["Service A"]
        KP1["Kprobe eBPF — jurisdiction ends here"]
        CE["Conduit Egress takes over at the boundary"]
        SA --> KP1 --> CE
    end

    NET(["Internet / VPN eBPF cannot operate here Conduit bridges this gap"])

    subgraph C2 ["Cluster 2"]
        CI["Conduit Ingress receives at the boundary"]
        KP2["Kprobe eBPF resumes here"]
        SB["Service B"]
        CI --> KP2 --> SB
    end

    CE -->|mTLS| NET -->|mTLS| CI

    style KP1 fill:#007F78,color:#fff
    style KP2 fill:#007F78,color:#fff
    style CE fill:#B85042,color:#fff
    style CI fill:#B85042,color:#fff
```

---

### 8.2 How Conduit gets its certificates — bootstrap before any request

```mermaid
sequenceDiagram
    participant Sigil as Sigil (Root CA)
    participant CE as Conduit Egress (Cluster 1)
    participant CI as Conduit Ingress (Cluster 2)

    Note over Sigil: Both clusters enrolled in mesh.yaml

    Sigil->>CE: Issue Cluster 1 boundary certificate
    Note over CE: Identity = "I am Cluster 1, signed by Sigil Root CA"

    Sigil->>CI: Issue Cluster 2 boundary certificate
    Note over CI: Identity = "I am Cluster 2, signed by Sigil Root CA"

    Sigil->>CE: Push cross-cluster allow policy
    Sigil->>CI: Push cross-cluster allow policy

    Note over CE,CI: Both hold the Sigil Root CA certificate
    Note over CE,CI: This shared root lets each verify the other ✅
    Note over CE,CI: Ready to establish cross-cluster mTLS
```

---

### 8.3 Full cross-cluster request — end to end

> Read top to bottom. Each component hands off to the next. The application (Service A and Service B) is completely unaware of everything in between.

```mermaid
sequenceDiagram
    actor SA as Service A
    participant KP1 as Kprobe (Cluster 1 Node)
    participant CE as Conduit Egress (Cluster 1 Edge)
    participant CI as Conduit Ingress (Cluster 2 Edge)
    participant KP2 as Kprobe (Cluster 2 Node)
    actor SB as Service B

    SA->>KP1: plain HTTP to Service B

    Note over KP1: Destination is in Cluster 2
    Note over KP1: Routes to Conduit Egress instead of direct network
    KP1->>CE: plain HTTP + Service A identity header

    Note over CE: ── CLUSTER 1 BOUNDARY ──
    Note over CE: Checks cross-cluster policy → ALLOW ✅
    Note over CE: Starts new mTLS session towards Cluster 2

    CE->>CI: TLS ClientHello — presents Cluster 1 boundary cert
    CI->>CE: TLS ServerHello — presents Cluster 2 boundary cert

    Note over CE: Verifies Cluster 2 cert → chains to Sigil Root CA ✅
    Note over CI: Verifies Cluster 1 cert → chains to Sigil Root CA ✅
    Note over CE,CI: Both clusters verified each other = cross-cluster mTLS ✅

    CE->>CI: encrypted application data over internet

    Note over CI: ── CLUSTER 2 BOUNDARY ──
    Note over CI: Decrypts payload
    Note over CI: Resolves Service B → target node inside Cluster 2
    CI->>KP2: plain HTTP handed off to Kprobe

    Note over KP2: Final intra-cluster policy check
    KP2->>SB: plain HTTP delivered

    CE-->>CE: emit egress boundary TelemetryRecord
    CI-->>CI: emit ingress boundary TelemetryRecord
```

---

### 8.4 Why cross-cluster verification works — certificate chain

> Both clusters chain to the same Sigil Root CA. That is the entire reason Cluster 2 can verify a certificate it has never seen before from Cluster 1 — they share a parent.

```mermaid
graph TB
    ROOT["🔐 Sigil Root CA Single root of trust Managed by MeshLite Private key never leaves Sigil"]

    INT1["Cluster 1 Intermediate CA Issued and signed by Sigil Root Signs all Cluster 1 certs"]
    INT2["Cluster 2 Intermediate CA Issued and signed by Sigil Root Signs all Cluster 2 certs"]

    SVC_A["Service A leaf cert"]
    SVC_B["Service B leaf cert"]
    COND_E["Conduit Egress cert Cluster 1 boundary identity"]
    SVC_C["Service C leaf cert"]
    COND_I["Conduit Ingress cert Cluster 2 boundary identity"]

    ROOT --> INT1
    ROOT --> INT2
    INT1 --> SVC_A
    INT1 --> SVC_B
    INT1 --> COND_E
    INT2 --> SVC_C
    INT2 --> COND_I

    VERIFY["✅ When Conduit Ingress (Cluster 2) receives Conduit Egress cert (Cluster 1) it walks up the chain: Cluster 1 Intermediate → Sigil Root Sigil Root is in its trust store Verification passes"]

    style ROOT fill:#0D1B3E,color:#fff
    style VERIFY fill:#007F78,color:#fff
```

---

## 9. Certificate Lifecycle

```mermaid
stateDiagram-v2
    direction LR

    [*] --> Requested : Service added to mesh.yaml

    Requested --> Issued : Sigil CA signs cert with 24h TTL

    Issued --> Distributed : Sigil pushes to Kprobe or Conduit via gRPC

    Distributed --> Active : Agent loads cert into in-memory CertStore

    Active --> Rotating : TTL under 1 hour — Sigil proactively renews

    Rotating --> Active : New cert pushed and loaded Old cert stays valid during overlap window Zero downtime rotation

    Active --> Revoked : Service removed from mesh.yaml or manual revocation event

    Revoked --> [*] : PolicyCache updated immediately All new connections refused
```

---

## 10. Policy Enforcement Model

### 10.1 From mesh.yaml to in-memory enforcement

```mermaid
graph LR
    YAML["mesh.yaml  allow:   - from: api-gateway     to: auth, orders   - from: orders     to: payments"]

    PE["Sigil Policy Engine Parses YAML rules Builds identity permission graph"]

    COMPILED["Compiled Policy Object api-gateway → auth = ALLOW api-gateway → orders = ALLOW orders → payments = ALLOW everything else = DENY"]

    DIST["Policy Distributor gRPC push to every Kprobe agent"]

    CACHE["Kprobe PolicyCache In-memory hash map Lookup under 1ms per packet"]

    YAML --> PE --> COMPILED --> DIST --> CACHE
```

---

### 10.2 Decision tree — every single packet

```mermaid
graph LR
    A["Packet intercepted by eBPF tc hook"]
    B["Resolve source pod → ServiceIdentity"]
    C["Resolve dest pod → ServiceIdentity"]
    D{mTLS mode?}
    E["Start TLS 1.3 handshake"]
    F{Peer cert valid? Signed by Sigil root?}
    G{Policy allows this src → dst?}
    H["✅ Forward payload to destination pod"]
    J["❌ DROP Invalid cert Alert sent to Trace"]
    K["❌ DROP Policy denied Metric sent to Trace"]

    A --> B --> C --> D
    D -->|ENFORCE| E --> F
    F -->|YES| G
    F -->|NO| J
    D -->|PERMISSIVE| G
    G -->|ALLOW| H
    G -->|DENY| K
```

---

## 11. Observability Architecture

### 11.1 How Trace collects data without any app changes

```mermaid
graph LR
    subgraph N1 ["Node 1"]
        KP1["Kprobe sees same-cluster traffic"]
        TE1["Async emitter best-effort only"]
        KP1 -->|HTTP/JSON telemetry| TE1
    end

    subgraph N2 ["Node 2"]
        KP2["Kprobe"]
        TE2["Async emitter"]
        KP2 -->|HTTP/JSON telemetry| TE2
    end

    subgraph EDGE ["Cluster Boundary"]
        CE_T["Conduit Egress owns cross-cluster outcome"]
        CI_T["Conduit Ingress reports TLS / routing failures"]
    end

    subgraph TRACE ["Trace"]
        AGG["In-memory aggregator"]
        API["/summary /topology /events"]
        PROM["/metrics Prometheus endpoint"]
        UI["Rancher-inspired dashboard"]
        AGG --> API
        AGG --> PROM
        API --> UI
    end

    CLI["meshctl"]
    EXT["Prometheus / Grafana"]

    TE1 -->|POST /api/v1/telemetry| AGG
    TE2 -->|POST /api/v1/telemetry| AGG
    CE_T -->|POST /api/v1/telemetry| AGG
    CI_T -->|POST /api/v1/telemetry| AGG
    CLI -->|reads Trace + Sigil APIs| API
    PROM --> EXT
```

---

### 11.2 `TelemetryRecord` — what every request produces

```mermaid
classDiagram
    direction LR

    class TelemetryRecord {
        +sourceService : String
        +destinationService : String
        +clusterID : String
        +leg : TrafficLeg
        +verdict : Verdict
        +latencyMs : Float
        +tlsVerified : Boolean
        +statusCode : Int?
        +errorReason : String?
        +timestamp : DateTime
    }

    class TrafficLeg {
        <<enumeration>>
        intra_cluster
        cross_cluster
    }

    class Verdict {
        <<enumeration>>
        allow
        deny
        tls_reject
        error
    }

    TelemetryRecord --> TrafficLeg : classified by
    TelemetryRecord --> Verdict : records outcome
```

---

### 11.3 Trace access model for real users

For the Phase 5 MVP, Trace is intended to run **inside the cluster** and be accessed in one of two ways:

1. **Local / development** — `kubectl port-forward svc/trace 3000:3000 9090:9090`
2. **Private consumer deployment** — an **internal ingress** or **internal load balancer** on a private DNS name such as `trace.mesh.internal`

This is the current “no-auth” story:

- acceptable for private/internal environments,
- acceptable behind VPN, internal VPC routing, or IP allowlists,
- **not** acceptable as a public internet-facing production model.

That boundary is deliberate: the MVP proves the operator workflow, while full auth/RBAC remains a later hardening step.

---
