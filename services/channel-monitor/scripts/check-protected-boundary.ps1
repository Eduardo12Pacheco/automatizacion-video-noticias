$ErrorActionPreference = "Stop"

param(
    [string] $BaseUrl = "http://127.0.0.1:8790",
    [switch] $RunNoLocalProviderTests
)

$ServiceRoot = Split-Path -Parent $PSScriptRoot
$EnvPath = Join-Path $ServiceRoot ".env"
$ApiKey = $env:CHANNEL_MONITOR_API_KEY
$BoundaryToken = $env:CHANNEL_MONITOR_NETWORK_BOUNDARY_TOKEN

function Import-ServiceEnv {
    if (-not (Test-Path -LiteralPath $EnvPath)) { return }
    Get-Content -LiteralPath $EnvPath | ForEach-Object {
        if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
        $Name, $Value = $_ -split '=', 2
        $TrimmedName = $Name.Trim()
        $TrimmedValue = $Value.Trim().Trim('"')
        if (-not [Environment]::GetEnvironmentVariable($TrimmedName, 'Process')) {
            [Environment]::SetEnvironmentVariable($TrimmedName, $TrimmedValue, 'Process')
        }
    }
}

function Redact-SecretText {
    param([string] $Text)
    if (-not $Text) { return $Text }
    $Redacted = $Text
    foreach ($Secret in @($ApiKey, $BoundaryToken, $env:CHANNEL_MONITOR_BOUNDARY_EVENT_API_KEY, $env:CHANNEL_MONITOR_CALLBACK_SECRET)) {
        if ($Secret) { $Redacted = $Redacted.Replace($Secret, "[redacted]") }
    }
    return $Redacted -replace '(x-api-key=)[^\s&"]+', '$1[redacted]'
}

Import-ServiceEnv
$ApiKey = [Environment]::GetEnvironmentVariable("CHANNEL_MONITOR_API_KEY", "Process")
$BoundaryUrl = [Environment]::GetEnvironmentVariable("CHANNEL_MONITOR_NETWORK_BOUNDARY_URL", "Process")
$BoundaryToken = [Environment]::GetEnvironmentVariable("CHANNEL_MONITOR_NETWORK_BOUNDARY_TOKEN", "Process")

Write-Host "Protected boundary smoke: this script does not start or restart services."
Write-Host "Step 1: Confirm radar-channel-monitor is stopped/manual before migration."
$Service = Get-Service -Name "radar-channel-monitor" -ErrorAction SilentlyContinue
if (-not $Service) {
    Write-Host "Service check: radar-channel-monitor is not installed on this host."
}
else {
    $CimService = Get-CimInstance -ClassName Win32_Service -Filter "Name='radar-channel-monitor'"
    if ($CimService.StartMode -ne "Manual") { throw "radar-channel-monitor StartType -eq 'Manual' check failed: $($CimService.StartMode)" }
    if ($Service.Status -eq "Running") { throw "radar-channel-monitor Status -ne 'Running' check failed: service is running" }
    Write-Host "Service check: StartType -eq 'Manual' and Status -ne 'Running'."
}

Write-Host "Step 2: Validate protected env config without printing secrets."
if ($env:CHANNEL_MONITOR_NETWORK_MODE -ne "protected") { throw "CHANNEL_MONITOR_NETWORK_MODE must be protected for this smoke." }
if (-not $BoundaryUrl) { throw "CHANNEL_MONITOR_NETWORK_BOUNDARY_URL is missing; expected boundary_misconfigured fail-closed behavior." }
if (-not $BoundaryToken) { throw "CHANNEL_MONITOR_NETWORK_BOUNDARY_TOKEN is missing; expected boundary_misconfigured fail-closed behavior." }
Write-Host "Protected env check: CHANNEL_MONITOR_NETWORK_MODE=protected, boundary URL configured, token=[redacted]."

Write-Host "Step 3: Check local protected preflight only; no external provider call is made."
if (-not $ApiKey) {
    Write-Host "Preflight skipped: CHANNEL_MONITOR_API_KEY is not configured."
}
else {
    $Headers = @{ "x-api-key" = $ApiKey }
    $Preflight = Invoke-WebRequest "$BaseUrl/api/monitor/preflight" -Headers $Headers -UseBasicParsing
    Write-Host "Preflight: $($Preflight.StatusCode) $(Redact-SecretText $Preflight.Content)"
}

Write-Host "Step 4: Confirm no local YouTube provider fallback with focused pytest guard command."
$GuardCommand = 'python -m pytest "services/channel-monitor/tests/test_youtube_client.py" "services/channel-monitor/tests/test_api.py" -k "protected or missing_boundary"'
Write-Host "Run this safe local test command when you need executable proof: $GuardCommand"
Write-Host "Expected safe failure codes include policy_forbidden_local_youtube and boundary_misconfigured; no local YouTube provider fallback is allowed."
if ($RunNoLocalProviderTests) {
    Push-Location -LiteralPath (Split-Path -Parent $ServiceRoot)
    try {
        python -m pytest "services/channel-monitor/tests/test_youtube_client.py" "services/channel-monitor/tests/test_api.py" -k "protected or missing_boundary"
    }
    finally {
        Pop-Location
    }
}
