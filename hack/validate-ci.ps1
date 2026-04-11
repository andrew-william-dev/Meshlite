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

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
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
        helm lint .\charts\sigil
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        helm lint .\charts\kprobe
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        helm lint .\charts\conduit
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        helm lint .\charts\trace
    }

    Invoke-Step 'helm dependency update umbrella chart' {
        Set-Location $repoRoot
        helm dependency update .\charts\meshlite
    }

    Invoke-Step 'helm lint umbrella chart' {
        Set-Location $repoRoot
        helm lint .\charts\meshlite
    }

    Invoke-Step 'helm template umbrella chart' {
        Set-Location $repoRoot
        $null = helm template meshlite .\charts\meshlite -n meshlite-system
    }

    Invoke-Step 'helm template EKS internal example' {
        Set-Location $repoRoot
        $null = helm template meshlite .\charts\meshlite -n meshlite-system -f .\charts\meshlite\examples\eks-internal-values.yaml
    }

    Write-Host "`nVALIDATION_OK" -ForegroundColor Green
}
finally {
    Pop-Location
}
