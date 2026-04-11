param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$Destination = '.release/charts'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$chartRoot = Join-Path $repoRoot 'charts'
$destinationPath = Join-Path $repoRoot $Destination

New-Item -ItemType Directory -Force -Path $destinationPath | Out-Null

Push-Location $repoRoot
try {
    helm dependency update .\charts\meshlite
    if ($LASTEXITCODE -ne 0) {
        throw 'helm dependency update failed'
    }

    foreach ($chart in @('sigil', 'kprobe', 'conduit', 'trace', 'meshlite')) {
        helm package (Join-Path $chartRoot $chart) --version $Version --app-version $Version --destination $destinationPath
        if ($LASTEXITCODE -ne 0) {
            throw "helm package failed for $chart"
        }
    }

    Write-Host "PACKAGED_OK -> $destinationPath" -ForegroundColor Green
}
finally {
    Pop-Location
}
