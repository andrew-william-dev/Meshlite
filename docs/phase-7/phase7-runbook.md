# MeshLite — Phase 7 Runbook

## Service Validator Demo Branch

> **Branch:** `service-validator`  
> **Purpose:** quick live demo for same-cluster and cross-cluster traffic visibility in Trace

---

## 1. What this demo gives you

After these steps, you will have:

- `validator-ui` in **cluster 1** with a small browser UI,
- a **same-cluster** button that calls `validator-same`,
- a **cross-cluster** button that calls `validator-cross` in **cluster 2** through Conduit,
- a repeatable way to watch those calls appear in **Trace**.

---

## 2. Prerequisites

- kind clusters already running:
  - `kind-meshlite-dev`
  - `kind-meshlite-dev-2`
- MeshLite components already installed:
  - Sigil
  - Kprobe
  - Conduit
  - Trace
- Docker available locally
- Go `1.25+`
- `meshctl` available from the repo

---

## 3. Build the demo image

```powershell
# PowerShell
Set-Location "D:\Projects\MeshLite\demo\service-validator"
go test ./...
docker build -t meshlite/service-validator:demo .
```

Expected result:

- Go tests pass
- Docker image `meshlite/service-validator:demo` exists locally

---

## 4. Load the image into both kind clusters

```powershell
# PowerShell
Set-Location "D:\Projects\MeshLite"
kind load docker-image --name meshlite-dev meshlite/service-validator:demo
kind load docker-image --name meshlite-dev-2 meshlite/service-validator:demo
```

---

## 5. Deploy the demo services

### Cluster 1

```powershell
# PowerShell
kubectl --context kind-meshlite-dev apply -f tests/fixtures/service-validator-cluster1.yaml
```

### Cluster 2

```powershell
# PowerShell
kubectl --context kind-meshlite-dev-2 apply -f tests/fixtures/service-validator-cluster2.yaml
```

### Verify pods

```powershell
# PowerShell
kubectl --context kind-meshlite-dev get pods -n meshlite-test -l app in (validator-ui,validator-same)
kubectl --context kind-meshlite-dev-2 get pods -n meshlite-test -l app=validator-cross
```

If the `-l app in (...)` expression behaves oddly in PowerShell, use separate commands:

```powershell
kubectl --context kind-meshlite-dev get pods -n meshlite-test -l app=validator-ui
kubectl --context kind-meshlite-dev get pods -n meshlite-test -l app=validator-same
kubectl --context kind-meshlite-dev-2 get pods -n meshlite-test -l app=validator-cross
```

---

## 6. Apply the demo mesh policy

First port-forward both Sigil services to different local ports.

```powershell
# PowerShell terminal A
kubectl --context kind-meshlite-dev -n meshlite-system port-forward svc/sigil 8080:8080

# PowerShell terminal B
kubectl --context kind-meshlite-dev-2 -n meshlite-system port-forward svc/sigil 8081:8080
```

Then apply the policy fixtures.

```powershell
# PowerShell terminal C
Set-Location "D:\Projects\MeshLite\meshctl"
go run . --sigil-url http://127.0.0.1:8080 apply -f ..\tests\fixtures\mesh-service-validator.yaml
go run . --sigil-url http://127.0.0.1:8081 apply -f ..\tests\fixtures\mesh-service-validator-2.yaml
```

Expected result:

```text
✅ applied ..\tests\fixtures\mesh-service-validator.yaml
✅ applied ..\tests\fixtures\mesh-service-validator-2.yaml
```

---

## 7. Stabilize the target URLs for the current lab

> **Recommended in this kind-based lab:** patch the UI deployment to use direct ClusterIPs before the live demo. This avoids the DNS flakiness already observed during earlier phases.

```powershell
# PowerShell
$SameIP = kubectl --context kind-meshlite-dev -n meshlite-test get svc validator-same -o jsonpath='{.spec.clusterIP}'
$EgressIP = kubectl --context kind-meshlite-dev -n meshlite-system get svc conduit-egress-conduit -o jsonpath='{.spec.clusterIP}'

kubectl --context kind-meshlite-dev -n meshlite-test set env deploy/validator-ui \
  SAME_TARGET_URL="http://$SameIP`:8080/api/ping" \
  CROSS_TARGET_URL="http://$EgressIP`:9090/api/ping"
```

Wait for the rollout to complete:

```powershell
kubectl --context kind-meshlite-dev -n meshlite-test rollout status deploy/validator-ui --timeout=120s
```

---

## 8. Open the demo UI and Trace

```powershell
# PowerShell terminal D
kubectl --context kind-meshlite-dev -n meshlite-test port-forward svc/validator-ui 8088:8080

# PowerShell terminal E
kubectl --context kind-meshlite-dev -n meshlite-system port-forward svc/trace 3000:3000 9090:9090
```

Now open:

- Demo UI: `http://127.0.0.1:8088`
- Trace UI: `http://127.0.0.1:3000`

### Optional: reset Trace to a clean live-demo state

Because Trace keeps data in memory and the current lab can accumulate noisy background edges, you can restart it before the walkthrough so the validator traffic stands out immediately:

```powershell
kubectl --context kind-meshlite-dev -n meshlite-system rollout restart deploy/trace
kubectl --context kind-meshlite-dev -n meshlite-system rollout status deploy/trace --timeout=120s
```

If you restart Trace, refresh the port-forward afterwards.

---

## 9. Live demo flow

### Same-cluster test

1. Open `http://127.0.0.1:8088`
2. Click **Call same-cluster service**
3. Confirm the response shows `validator-same reachable`
4. In Trace, look for the `validator-ui -> validator-same` edge

### Cross-cluster test

1. In the same UI, click **Call cross-cluster service**
2. Confirm the response shows `validator-cross reachable`
3. In Trace, look for the `validator-ui -> validator-cross` / `cross_cluster` activity

---

## 10. Command-line verification fallback

If you want to test without the browser, run:

```powershell
Invoke-WebRequest -UseBasicParsing -Method POST http://127.0.0.1:8088/api/call/same | Select-Object -ExpandProperty Content
Invoke-WebRequest -UseBasicParsing -Method POST http://127.0.0.1:8088/api/call/cross | Select-Object -ExpandProperty Content
```

And confirm Trace metrics include the validator traffic:

```powershell
(Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:9090/metrics').Content |
  Select-String 'validator-ui|validator-same|validator-cross' |
  ForEach-Object { $_.Line }
```

---

## 11. If cluster DNS is flaky

If the same-cluster button fails because in-pod DNS is unstable in the current lab, patch the `validator-ui` target URL to use the current service ClusterIP.

```powershell
$SameIP = kubectl --context kind-meshlite-dev -n meshlite-test get svc validator-same -o jsonpath='{.spec.clusterIP}'
kubectl --context kind-meshlite-dev -n meshlite-test set env deploy/validator-ui SAME_TARGET_URL="http://$SameIP`:8080/api/ping"
```

If the cross-cluster button needs the egress ClusterIP explicitly:

```powershell
$EgressIP = kubectl --context kind-meshlite-dev -n meshlite-system get svc conduit-egress-conduit -o jsonpath='{.spec.clusterIP}'
kubectl --context kind-meshlite-dev -n meshlite-test set env deploy/validator-ui CROSS_TARGET_URL="http://$EgressIP`:9090/api/ping"
```

Then retry the buttons.

---

## 12. Cleanup

```powershell
kubectl --context kind-meshlite-dev delete -f tests/fixtures/service-validator-cluster1.yaml
kubectl --context kind-meshlite-dev-2 delete -f tests/fixtures/service-validator-cluster2.yaml
```

The demo image can remain loaded locally for later reruns.
