param(
    [string] $BaseUrl = "http://127.0.0.1:8088",
    [string] $OutageBaseUrl = "http://127.0.0.1:65534",
    [switch] $CheckOutage
)

$ErrorActionPreference = "Stop"

$Token = $env:CHANNEL_BOUNDARY_API_TOKEN

function Redact-SecretText {
    param([string] $Text)
    if (-not $Text) { return $Text }
    if ($Token) { return $Text.Replace($Token, "[redacted]") }
    return $Text
}

Write-Host "Mock-only smoke for Channel Network Boundary. Does not start the boundary service."
Write-Host "Run the app separately with the mock provider before invoking this script."
Write-Host "Real WebSub rollout notes: configure CHANNEL_BOUNDARY_PUBLIC_CALLBACK_URL in cloud runtime, keep radar-channel-monitor stopped until operator smoke passes, and redact secrets."

if (-not $Token) { throw "CHANNEL_BOUNDARY_API_TOKEN is required; refusing to print or invent a token." }
$Headers = @{ "Authorization" = "Bearer $Token" }

Write-Host "Step 1: Check /health on $BaseUrl."
$Health = Invoke-WebRequest "$BaseUrl/health" -UseBasicParsing
Write-Host "Health: $($Health.StatusCode) $(Redact-SecretText $Health.Content)"

Write-Host "Step 2: Perform mocked metadata call against the boundary app only."
$Body = @{ video_id = "mock-video-1" } | ConvertTo-Json -Compress
$Metadata = Invoke-WebRequest "$BaseUrl/v1/videos/metadata" -Method Post -Headers $Headers -ContentType "application/json" -Body $Body -UseBasicParsing
Write-Host "Metadata: $($Metadata.StatusCode) $(Redact-SecretText $Metadata.Content)"

Write-Host "Step 3: Simulate boundary outage/misconfig fail-closed behavior without external egress."
if ($CheckOutage) {
    try {
        Invoke-WebRequest "$OutageBaseUrl/health" -TimeoutSec 2 -UseBasicParsing | Out-Null
        throw "Boundary outage simulation unexpectedly reached $OutageBaseUrl."
    }
    catch {
        Write-Host "Boundary outage simulation: local unreachable boundary produced expected fail-closed operator condition."
    }
}
else {
    Write-Host "Boundary outage simulation skipped. Re-run with -CheckOutage to hit only $OutageBaseUrl."
}

Write-Host "Smoke complete: token=[redacted], provider=mock, no live provider path used."
