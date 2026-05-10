param(
    [switch]$IncludeSolanaStatus,
    [switch]$RunAgentSolanaE2E
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$clientDir = Join-Path $repoRoot "client"

function Invoke-Step {
    param(
        [string]$Name,
        [string]$WorkingDirectory,
        [string]$FilePath,
        [string[]]$Arguments
    )

    Write-Host "==> $Name"
    Push-Location $WorkingDirectory
    try {
        & $FilePath @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "$Name failed with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }
}

Invoke-Step `
    -Name "Rust Anchor program cargo check" `
    -WorkingDirectory $repoRoot `
    -FilePath "cargo" `
    -Arguments @("check")

Invoke-Step `
    -Name "TypeScript client/backend/agent test suite" `
    -WorkingDirectory $clientDir `
    -FilePath "npm.cmd" `
    -Arguments @("test")

if ($IncludeSolanaStatus) {
    Invoke-Step `
        -Name "Solana RPC/program readiness" `
        -WorkingDirectory $clientDir `
        -FilePath "npm.cmd" `
        -Arguments @("run", "solana:status")
}

if ($RunAgentSolanaE2E) {
    Invoke-Step `
        -Name "Agent-planned Solana e2e" `
        -WorkingDirectory $clientDir `
        -FilePath "npm.cmd" `
        -Arguments @("run", "agent-solana:e2e")
}

Write-Host "Accural MVP verification completed."
