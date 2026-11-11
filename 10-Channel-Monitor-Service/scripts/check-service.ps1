$ErrorActionPreference = "Stop"

$ServiceRoot = Split-Path -Parent $PSScriptRoot
$EnvPath = Join-Path $ServiceRoot ".env"
$ApiKey = $env:CHANNEL_MONITOR_API_KEY
$BaseUrl = "http://127.0.0.1:8775"

function Redact-SecretText {
    param([string] $Text)
    if (-not $Text) { return $Text }
    $Redacted = $Text
    foreach ($Secret in @($ApiKey, $env:CHANNEL_MONITOR_RADAR_API_KEY, $env:CHANNEL_MONITOR_YOUTUBE_API_KEY, $env:CHANNEL_MONITOR_CALLBACK_SECRET)) {
        if ($Secret) { $Redacted = $Redacted.Replace($Secret, "[redacted]") }
    }
    return $Redacted -replace '(x-api-key=)[^\s&"]+', '$1[redacted]'
}

if (-not $ApiKey -and (Test-Path -LiteralPath $EnvPath)) {
    Get-Content -LiteralPath $EnvPath | ForEach-Object {
        if ($_ -match '^\s*CHANNEL_MONITOR_API_KEY\s*=') {
            $script:ApiKey = ($_ -split '=', 2)[1].Trim().Trim('"')
        }
    }
}

$Live = Invoke-WebRequest "$BaseUrl/api/monitor/live" -UseBasicParsing
Write-Host "Live: $($Live.StatusCode) $($Live.Content)"

if ($ApiKey) {
    $Headers = @{ "x-api-key" = $ApiKey }
    $Health = Invoke-WebRequest "$BaseUrl/api/monitor/preflight" -Headers $Headers -UseBasicParsing
    Write-Host "Preflight: $($Health.StatusCode) $(Redact-SecretText $Health.Content)"
}
else {
    Write-Host "Preflight skipped: CHANNEL_MONITOR_API_KEY is not configured"
}
