# MeshLite — Phase 7 Approach
## Service Validator Demo Branch

---

## 1. Goal

Prove MeshLite in a way that is **easy to see live**: one simple UI service in cluster 1 can trigger a same-cluster call and a cross-cluster call with a button press, and both flows become visible in Trace immediately.

---

## 2. Scope

### In scope

| Item | Description |
|---|---|
| `service-validator` branch | Dedicated demo branch for a presentable live walkthrough |
| Simple demo app | A lightweight HTTP app with a tiny UI and two buttons: same-cluster call and cross-cluster call |
| Three demo services | `validator-ui` and `validator-same` in cluster 1, `validator-cross` in cluster 2 |
| Demo manifests | Kubernetes YAML for both clusters plus mesh policy fixtures |
| Demo runbook | Exact build / deploy / port-forward / test steps for a live product walkthrough |

### NOT in scope

- A production-ready customer-facing UI
- Auth / login for the demo app
- Full backend business logic
- Long-term storage or analytics for the demo events
- Replacing the main Trace UI; this is only a traffic generator / explainer app

---

## 3. Components

1. **`demo/service-validator/`**
   - single Go app,
   - serves a small web page,
   - exposes `/api/call/same` and `/api/call/cross`,
   - shows the latest local event results after each click.

2. **Cluster 1 manifests**
   - `validator-ui`
   - `validator-same`

3. **Cluster 2 manifests**
   - `validator-cross`

4. **Mesh policy fixtures**
   - allow `validator-ui -> validator-same`
   - allow `validator-ui -> validator-cross` via Conduit
   - preserve Conduit → Sigil / Trace access

---

## 4. Dependencies

| Dependency | Status |
|---|---|
| Phase 5 Trace + `meshctl` MVP | ✅ complete |
| Phase 6 packaging / release flow | ✅ complete |
| Two kind clusters and Conduit path | ✅ already available in the lab environment |
| Live Trace access via port-forward | ✅ available |

---

## 5. Exit Criteria

| ID | Criterion |
|---|---|
| **7.A** | `validator-ui` opens locally through a port-forward and shows both demo buttons |
| **7.B** | The same-cluster button successfully reaches `validator-same` and returns a visible result |
| **7.C** | The cross-cluster button successfully reaches `validator-cross` through Conduit and returns a visible result |
| **7.D** | Trace shows the `validator-ui -> validator-same` and `validator-ui -> validator-cross` traffic during the demo |
| **7.E** | A step-by-step runbook exists so the full demo can be recreated quickly on demand |

---

## 6. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Current lab DNS can be flaky inside the cluster | Medium | Keep target URLs configurable by env and document a ClusterIP fallback in the runbook |
| The demo could become too complicated | Medium | Keep to one small Go app image reused for all three services |
| Cross-cluster flow may fail if policy is not aligned | High | Ship dedicated mesh policy fixtures for the demo scenario |
| The UI may look too rough | Low | Focus on clarity and a very obvious “click → result → Trace update” loop |
