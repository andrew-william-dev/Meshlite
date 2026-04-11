# MeshLite — Final Architecture Explainer

> **Audience:** product, demo, and engineering stakeholders  
> **Goal:** explain how MeshLite works as a complete system after the Phase 5 MVP

---

## 1. What MeshLite actually is

MeshLite is a **lightweight zero-trust networking layer for Kubernetes**.

It gives a team four things without asking application teams to rewrite their services:

1. **service identity** — every service gets a Sigil-issued certificate,
2. **policy enforcement** — allowed and denied traffic is decided from `mesh.yaml`,
3. **cross-cluster protection** — traffic between clusters is wrapped and verified at the boundary,
4. **operator visibility** — Trace and `meshctl` show what is happening in real time.

The key idea is simple:

- **inside one cluster**, MeshLite uses **Kprobe (eBPF)**,
- **between clusters**, MeshLite uses **Conduit gateways**,
- **for control and identity**, MeshLite uses **Sigil**,
- **for visibility and operations**, MeshLite uses **Trace** and **`meshctl`**.

---

## 2. The four main runtime components

| Component | Role | Why it exists |
|---|---|---|
| **Sigil** | Control plane + certificate authority | Issues service certificates, stores policy, pushes updates, and handles rotation |
| **Kprobe** | Same-cluster enforcer | Intercepts pod-to-pod traffic at the kernel/network layer and applies allow/deny + mTLS behavior |
| **Conduit** | Cross-cluster gateway | Protects traffic once it leaves one cluster and before it enters another |
| **Trace** | Observability and operator UI | Shows service graph, events, request totals, denials, and latency |

---

## 3. How a same-cluster request works

When `service-alpha` calls `service-beta` in the **same Kubernetes cluster**, the flow is:

1. `service-alpha` sends a normal HTTP request.
2. **Kprobe** intercepts the traffic at the node level.
3. Kprobe resolves **who is calling** and **who is being called**.
4. Kprobe checks the live policy from Sigil.
   - if the policy says **ALLOW**, the request proceeds;
   - if the policy says **DENY**, the request is blocked.
5. Kprobe emits a telemetry record to **Trace**.
6. Trace updates the service graph, counters, and recent events feed.

**Why this matters:** the application code stays unchanged. The service still behaves like a normal app, while MeshLite provides identity, enforcement, and visibility underneath it.

---

## 4. How a cross-cluster request works

When a service in **cluster 1** needs to talk to a service in **cluster 2**, eBPF alone is not enough because the packet leaves the original cluster. That is where **Conduit** takes over.

### Cross-cluster path

1. `service-alpha` in cluster 1 starts the request.
2. **Kprobe** on cluster 1 recognizes that the destination is outside the local cluster.
3. The request is handed to **Conduit Egress**.
4. Conduit Egress applies the cross-cluster policy and establishes the protected connection.
5. The traffic crosses the private network / VPN / peered network.
6. **Conduit Ingress** in cluster 2 receives it, verifies identity, and forwards it into the destination cluster.
7. The request reaches `service-beta`.
8. Conduit and Kprobe both emit telemetry so **Trace** can show the call as `cross_cluster`.

**Why this matters:** MeshLite keeps the same zero-trust story even when traffic moves beyond a single node or cluster boundary.

---

## 5. How operators interact with the system

MeshLite now has two operator surfaces:

### `meshctl`

Used for fast command-line operations such as:

- `meshctl apply -f mesh.yaml`
- `meshctl status`
- `meshctl verify --from service-alpha --to service-beta`
- `meshctl logs --service service-beta`
- `meshctl rotate --service service-alpha`

### Trace

Used for visual operations such as:

- viewing the **service graph**,
- seeing request totals and denials,
- spotting cross-cluster edges,
- reviewing recent policy or TLS-related events.

The UI is intentionally **Rancher-inspired**: admin-console style, fast to scan, and focused on operator workflows rather than consumer-facing polish.

---

## 6. How Trace is accessed in a real EKS-style deployment

For a real self-hosted customer or internal platform team, the intended access model is:

- Trace runs **inside the Kubernetes cluster**,
- it is exposed by an **internal ingress** or **internal load balancer**,
- it is reachable on a **private/internal DNS name** such as `https://trace.mesh.internal`.

### Important boundary

The current MVP supports **no application-level auth** only when the environment is already private, for example:

- corporate VPN,
- internal VPC routing,
- security groups,
- internal ALB/NLB,
- IP allowlists.

> MeshLite should **not** present Trace as a public no-auth website. For public/shared production use, authentication and RBAC still need to be added.

---

## 7. Why this architecture fits the MVP

This architecture is a good MVP shape because it keeps the system small and understandable:

- no sidecars in every workload,
- no app code changes,
- one central identity and policy service,
- one boundary component for cross-cluster traffic,
- one UI + CLI pair for operators.

That gives a clear story for demos and internal evaluation:

**“MeshLite secures service-to-service traffic, shows what is happening live, and lets operators inspect or change policy from one place.”**

---

## 8. Current MVP limits

The architecture is now coherent, but it is still an **MVP**, not a full production-grade `v1.0.0` platform.

Main limitations still remaining:

- Trace currently keeps state **in memory**,
- no full **auth / RBAC / SSO** yet,
- metric noise from infra traffic still needs refinement,
- EKS/private-ingress packaging can be hardened further,
- production HA and persistence decisions are still ahead.

---

## 9. Final one-paragraph explanation

If you explain MeshLite to a stakeholder in one paragraph, it is this:

> **MeshLite is a lightweight Kubernetes zero-trust mesh that secures same-cluster traffic with eBPF, secures cross-cluster traffic with boundary gateways, uses a central control plane for service identity and policy, and now exposes a Rancher-inspired UI plus `meshctl` so operators can see live traffic, denials, and topology without changing application code.**
