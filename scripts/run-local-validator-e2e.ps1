param(
  [string]$RpcUrl = "http://127.0.0.1:8899",
  [string]$Ledger = ""
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$solanaBin = Join-Path $root "solana-release\bin"
$env:HOME = $env:USERPROFILE
$validator = Join-Path $solanaBin "solana-test-validator.exe"
$programSo = Join-Path $root "target\deploy\accural.so"
$defaultLedger = Join-Path ([System.IO.Path]::GetTempPath()) "accural-test-ledger-$PID"
$ledger = if ($Ledger) { $Ledger } else { $defaultLedger }
$logRoot = Join-Path $root "test-logs"
$stdoutLog = Join-Path $logRoot "validator.out.log"
$stderrLog = Join-Path $logRoot "validator.err.log"
$programId = "HTVTUMeyRkpbakNASCQ44MzgjxKjrV5oG8rBSavMiPCS"

if (!(Test-Path $validator)) {
  throw "Missing bundled solana-test-validator at $validator"
}

if (-not (($env:PATH -split ';') -contains $solanaBin)) {
  $env:PATH = "$solanaBin;$env:PATH"
}

Push-Location $root
try {
  & cargo-build-sbf --manifest-path programs\accural\Cargo.toml --sbf-out-dir target\deploy
  if ($LASTEXITCODE -ne 0) {
    throw "cargo-build-sbf failed with exit code $LASTEXITCODE"
  }

  if (!(Test-Path $programSo)) {
    throw "Missing built program artifact at $programSo"
  }

  New-Item -ItemType Directory -Path $ledger -Force | Out-Null
  if (!(Test-Path $logRoot)) {
    New-Item -ItemType Directory -Path $logRoot | Out-Null
  }

  $validatorArgs = @(
    "--reset",
    "--quiet",
    "--ledger", $ledger,
    "--bpf-program", $programId, $programSo
  )



  $process = $null
  $process = Start-Process `
    -FilePath $validator `
    -ArgumentList $validatorArgs `
    -WindowStyle Hidden `
    -PassThru `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog

  try {
    Push-Location (Join-Path $root "client")
    $env:ACCURAL_RPC_URL = $RpcUrl
    Write-Host "Waiting for validator RPC at $RpcUrl..."
    $deadline = (Get-Date).AddSeconds(45)
    do {
      if ($process.HasExited) {
        $stderr = if (Test-Path $stderrLog) { Get-Content $stderrLog -Raw } else { "" }
        throw "solana-test-validator exited before RPC became ready. stderr: $stderr"
      }
      npm.cmd run solana:status *> $null
      if ($LASTEXITCODE -eq 0) {
        break
      }
      Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    if ((Get-Date) -ge $deadline) {
      throw "Validator did not become ready before timeout. See $stdoutLog and $stderrLog"
    }
    npm.cmd run solana:e2e
    if ($LASTEXITCODE -ne 0) {
      throw "npm.cmd run solana:e2e failed with exit code $LASTEXITCODE. Validator stderr: $stderrLog"
    }
  } finally {
    Pop-Location
    if ($null -ne $process -and !$process.HasExited) {
      Stop-Process -Id $process.Id -Force
    }
  }
} finally {
  Pop-Location
}
