$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-Step {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][scriptblock]$Action
    )

    Write-Host "`n==> $Name" -ForegroundColor Cyan
    & $Action
    if ($LASTEXITCODE -ne 0) {
        throw "Step failed: $Name"
    }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$chartsRoot = Join-Path $repoRoot 'charts'
$meshliteChart = Join-Path $chartsRoot 'meshlite'
$eksExampleValues = Join-Path $meshliteChart 'examples/eks-internal-values.yaml'
$canRunSigilTests = $true
$canRunKprobeUserspaceTests = $true
$runningOnWindows = $env:OS -eq 'Windows_NT'

if ($runningOnWindows -and -not (Get-Command gcc -ErrorAction SilentlyContinue)) {
    Write-Warning 'Skipping sigil host tests on Windows because gcc/CGO is not available in PATH.'
    $canRunSigilTests = $false
}

if ($runningOnWindows) {
    Write-Warning 'Skipping kprobe-userspace host tests on Windows because Aya uses Linux-specific file descriptor APIs in this path.'
    $canRunKprobeUserspaceTests = $false
}

Push-Location $repoRoot
try {
    Invoke-Step 'trace/backend go test' {
        Set-Location (Join-Path $repoRoot 'trace/backend')
        go test ./...
    }

    Invoke-Step 'meshctl go test' {
        Set-Location (Join-Path $repoRoot 'meshctl')
        go test ./...
    }

    if ($canRunSigilTests) {
        Invoke-Step 'sigil go test' {
            Set-Location (Join-Path $repoRoot 'sigil')
            go test ./...
        }
    }

    Invoke-Step 'conduit cargo test' {
        Set-Location (Join-Path $repoRoot 'conduit')
        cargo test
    }

    if ($canRunKprobeUserspaceTests) {
        Invoke-Step 'kprobe-userspace cargo test' {
            Set-Location (Join-Path $repoRoot 'kprobe')
            cargo test --package kprobe-userspace
        }
    }

    Invoke-Step 'trace/frontend npm ci + build' {
        Set-Location (Join-Path $repoRoot 'trace/frontend')
        npm ci
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        npm run build
    }

    Invoke-Step 'helm lint subcharts' {
        Set-Location $repoRoot
        foreach ($chart in @('sigil', 'kprobe', 'conduit', 'trace')) {
            helm lint (Join-Path $chartsRoot $chart)
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        }
    }

    Invoke-Step 'helm dependency update umbrella chart' {
        Set-Location $repoRoot
        helm dependency update $meshliteChart
    }

    Invoke-Step 'helm lint umbrella chart' {
        Set-Location $repoRoot
        helm lint $meshliteChart
    }

    Invoke-Step 'helm template umbrella chart' {
        Set-Location $repoRoot
        $null = helm template meshlite $meshliteChart -n meshlite-system
    }

    Invoke-Step 'helm template EKS internal example' {
        Set-Location $repoRoot
        $null = helm template meshlite $meshliteChart -n meshlite-system -f $eksExampleValues
    }

    Write-Host "`nVALIDATION_OK" -ForegroundColor Green
}
finally {
    Pop-Location
}
