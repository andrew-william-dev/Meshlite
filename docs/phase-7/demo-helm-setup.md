# MeshLite — Demo Setup (Helm)

> **Branch:** `service-validator`  
> **Updated:** April 13, 2026  
> **Replaces:** raw-YAML approach in `phase7-runbook.md`

Sets up the service-validator live demo end-to-end using the Helm chart.  
After these steps you will have a browser UI in **cluster-1** with a same-cluster button and a cross-cluster button, and every click will appear in **Trace**.

---

## Prerequisites

Both kind clusters must already be running with MeshLite platform components installed.

```powershell
# Verify clusters
kubectl --context kind-meshlite-dev get nodes
kubectl --context kind-meshlite-dev-2 get nodes

# Verify platform pods (cluster-1)
kubectl --context kind-meshlite-dev get pods -n meshlite-system

# Verify platform pods (cluster-2)
kubectl --context kind-meshlite-dev-2 get pods -n meshlite-system
```

If the clusters are not running, re-create them first:

```powershell
bash hack/dev-cluster.sh
```

---

## 1. Build the demo image

```powershell
Set-Location "D:\Projects\MeshLite\demo\service-validator"
docker build -t meshlite/service-validator:demo-fix .
```

Expected: image `meshlite/service-validator:demo-fix` present in `docker images`.

---

## 2. Load the image into both kind clusters

```powershell
Set-Location "D:\Projects\MeshLite"
kind load docker-image meshlite/service-validator:demo-fix --name meshlite-dev
kind load docker-image meshlite/service-validator:demo-fix --name meshlite-dev-2
```

---

## 3. Deploy the cross service on cluster-2

```powershell
Set-Location "D:\Projects\MeshLite"
helm upgrade --install validator-demo ./charts/meshlite `
  --kube-context kind-meshlite-dev-2 `
  --values charts/meshlite/examples/demo-cluster2-values.yaml
```

Verify:

```powershell
kubectl --context kind-meshlite-dev-2 get pods -n meshlite-test -l app=validator-cross
# Expected: 1/1 Running
```

---

## 4. Deploy the same service on cluster-1 (no UI yet)

This creates `validator-same` so we can capture its ClusterIP before enabling the UI.

```powershell
helm upgrade --install validator-demo ./charts/meshlite `
  --kube-context kind-meshlite-dev `
  --values charts/meshlite/examples/demo-cluster1-values.yaml `
  --set demo.ui.enabled=false
```

Verify:

```powershell
kubectl --context kind-meshlite-dev get pods -n meshlite-test -l app=validator-same
# Expected: 1/1 Running
```

---

## 5. Capture ClusterIPs

```powershell
$sameIp = kubectl --context kind-meshlite-dev `
  get svc validator-same -n meshlite-test `
  -o jsonpath='{.spec.clusterIP}'

$egressIp = kubectl --context kind-meshlite-dev `
  get svc conduit-egress-conduit -n meshlite-system `
  -o jsonpath='{.spec.clusterIP}'

Write-Host "same-cluster target : http://$($sameIp):8080/api/ping"
Write-Host "cross-cluster target: http://$($egressIp):9090/api/ping"
```

> **Note:** PowerShell requires `$($var)` syntax inside double-quoted strings — plain `$var` will silently expand to empty.

---

## 6. Upgrade cluster-1 to enable the UI

```powershell
helm upgrade --install validator-demo ./charts/meshlite `
  --kube-context kind-meshlite-dev `
  --values charts/meshlite/examples/demo-cluster1-values.yaml `
  --set "demo.ui.sameTargetUrl=http://$($sameIp):8080/api/ping" `
  --set "demo.ui.crossTargetUrl=http://$($egressIp):9090/api/ping"
```

Verify all cluster-1 demo pods:

```powershell
kubectl --context kind-meshlite-dev get pods -n meshlite-test
# Expected:
#   validator-ui-...    1/1 Running
#   validator-same-...  1/1 Running
```

---

## 7. Open the demo UI

```powershell
kubectl --context kind-meshlite-dev `
  -n meshlite-test port-forward svc/validator-ui 9099:80
```

Open **http://localhost:9099** in a browser.

- **Same-cluster** button → calls `validator-same` directly (expected: 200, ~2 ms)
- **Cross-cluster** button → calls `validator-cross` through Conduit egress (expected: 200, ~10 ms)

---

## 8. Open Trace to watch traffic

In a separate PowerShell terminal:

```powershell
kubectl --context kind-meshlite-dev `
  -n meshlite-system port-forward svc/trace 3000:3000
```

Open **http://localhost:3000** in a browser.

Click the demo buttons a few times, then refresh Trace.  
You should see entries similar to:

| Source | Destination | Latency | Status |
|--------|-------------|---------|--------|
| cluster/cluster-1 | validator-same | ~2 ms | allow |
| cluster/cluster-1 | validator-cross | ~10 ms | allow |

---

## 9. Verify Trace metrics directly (optional)

```powershell
kubectl --context kind-meshlite-dev `
  -n meshlite-system port-forward svc/trace 9091:9091
```

```powershell
Invoke-RestMethod http://localhost:9091/metrics | `
  Select-String "meshlite_requests_total"
```

Expected lines similar to:

```
meshlite_requests_total{dst="validator-same", src="cluster/cluster-1", verdict="allow"} 5
meshlite_requests_total{dst="validator-cross", src="cluster/cluster-1", verdict="allow"} 5
```

---

## 10. Reset Trace state (if needed)

Rolls the Trace deployment to clear in-memory event history:

```powershell
kubectl --context kind-meshlite-dev `
  -n meshlite-system rollout restart deploy/trace

# Wait for rollout
kubectl --context kind-meshlite-dev `
  -n meshlite-system rollout status deploy/trace
```

After the rollout completes, re-open port-forward and refresh the browser.

---

## 11. Tear down / re-deploy

To completely remove the demo releases:

```powershell
helm --kube-context kind-meshlite-dev   uninstall validator-demo
helm --kube-context kind-meshlite-dev-2 uninstall validator-demo
```

Re-run steps 3 → 7 to reinstall.

---

## Helm release status

```powershell
helm --kube-context kind-meshlite-dev   list -n meshlite-test
helm --kube-context kind-meshlite-dev-2 list -n meshlite-test
```

---

## Troubleshooting

| Symptom | Check |
|---------|-------|
| `validator-same` pod in `ImagePullBackOff` | Re-run step 2 (`kind load …`) |
| `Error from server (NotFound): services "validator-same"` | You queried before step 4 — run step 4 first |
| UI buttons return error | `kubectl logs -n meshlite-test deploy/validator-ui` |
| Cross-cluster returns error | Check Conduit egress pod logs: `kubectl --context kind-meshlite-dev logs -n meshlite-system deploy/conduit-egress-conduit` |
| Trace shows ~91,000 ms latency | Ensure you are on the `service-validator` branch with the telemetry fix in `conduit/src/egress.rs` |
| `$sameIp` or `$egressIp` is empty in Helm set | Use `$($sameIp)` syntax — not `$sameIp` — in PowerShell double-quoted strings |
