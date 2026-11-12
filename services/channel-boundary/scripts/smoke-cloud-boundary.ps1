param(
    [Parameter(Mandatory = $true)][string] $BaseUrl,
    [Parameter(Mandatory = $true)][string] $ChannelSource,
    [Parameter(Mandatory = $true)][string] $VideoId,
    [Parameter(Mandatory = $true)][string] $UploadsPlaylistId,
    [string] $SubtitleLanguage = "en",
    [string] $WebSubChannelId,
    [string] $ExpectedProvider = "youtube"
)

$ErrorActionPreference = "Stop"

$Token = [Environment]::GetEnvironmentVariable("CHANNEL_BOUNDARY_API_TOKEN", "Process")

function Redact-SecretText {
    param([string] $Text)
    if (-not $Text) { return $Text }
    if ($Token) { return $Text.Replace($Token, "[redacted]") }
    return $Text
}

function Invoke-BoundaryJson {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)] $Body
    )

    $Headers = @{ "Authorization" = "Bearer $Token" }
    $JsonBody = $Body | ConvertTo-Json -Compress
    $Response = Invoke-WebRequest "$BaseUrl$Path" -Method Post -Headers $Headers -ContentType "application/json" -Body $JsonBody -UseBasicParsing
    return ($Response.Content | ConvertFrom-Json)
}

if (-not $Token) {
    throw "CHANNEL_BOUNDARY_API_TOKEN is required. Refusing cloud smoke without the boundary bearer token."
}

if (-not $BaseUrl.StartsWith("https://")) {
    throw "Refusing cloud smoke: BaseUrl must be the HTTPS Cloud Run or API Gateway URL."
}

Write-Host "Cloud smoke for Channel Network Boundary. This does not deploy and does not restart services."
Write-Host "Secrets: token=[redacted]; API keys and forwarding credentials stay in cloud runtime."
Write-Host 'Health assertion: JSON field "provider" must equal "youtube".'
Write-Host "Step 1: /health must report provider youtube."
$HealthResponse = Invoke-WebRequest "$BaseUrl/health" -UseBasicParsing
$Health = $HealthResponse.Content | ConvertFrom-Json
if ($Health.data.provider -ne $ExpectedProvider) {
    throw "Refusing cloud smoke: expected provider $ExpectedProvider but /health reported $($Health.data.provider)."
}
Write-Host "Health: status=$($HealthResponse.StatusCode), service=$($Health.data.service), provider=$($Health.data.provider)"

Write-Host "Step 2: /v1/channels/resolve safe sample."
$Resolved = Invoke-BoundaryJson -Path "/v1/channels/resolve" -Body @{ source = $ChannelSource }
if (-not $Resolved.ok) { throw "Resolve failed: $(Redact-SecretText ($Resolved | ConvertTo-Json -Compress))" }
Write-Host "Resolve: ok, channel_id=$($Resolved.data.channel_id), uploads_playlist_id=$($Resolved.data.uploads_playlist_id)"

Write-Host "Step 3: /v1/videos/metadata safe sample."
$Metadata = Invoke-BoundaryJson -Path "/v1/videos/metadata" -Body @{ video_id = $VideoId }
if (-not $Metadata.ok) { throw "Metadata failed: $(Redact-SecretText ($Metadata | ConvertTo-Json -Compress))" }
Write-Host "Metadata: ok, video_id=$($Metadata.data.video_id), channel_id=$($Metadata.data.channel_id)"

Write-Host "Step 4: /v1/playlists/uploads safe sample."
$Uploads = Invoke-BoundaryJson -Path "/v1/playlists/uploads" -Body @{ uploads_playlist_id = $UploadsPlaylistId; item_limit = 2; page_limit = 1 }
if (-not $Uploads.ok) { throw "Uploads failed: $(Redact-SecretText ($Uploads | ConvertTo-Json -Compress))" }
Write-Host "Uploads: ok, items=$($Uploads.data.items.Count)"

Write-Host "Step 5: /v1/subtitles/fetch safe sample; unavailable subtitles are a fail-closed provider result to investigate, not a reason for local fallback."
$Subtitles = Invoke-BoundaryJson -Path "/v1/subtitles/fetch" -Body @{ video_id = $VideoId; default_language = $SubtitleLanguage }
if (-not $Subtitles.ok) { throw "Subtitles failed closed: $(Redact-SecretText ($Subtitles | ConvertTo-Json -Compress))" }
Write-Host "Subtitles: ok, segments=$($Subtitles.data.segments.Count)"

if ($WebSubChannelId) {
    Write-Host "Step 6: /v1/websub/renew operator-approved sample."
    $WebSub = Invoke-BoundaryJson -Path "/v1/websub/renew" -Body @{ channel_id = $WebSubChannelId; lease_seconds = 3600 }
    if (-not $WebSub.ok) { throw "WebSub failed closed: $(Redact-SecretText ($WebSub | ConvertTo-Json -Compress))" }
    Write-Host "WebSub: ok, accepted=$($WebSub.data.accepted), channel_id=$($WebSub.data.channel_id)"
}
else {
    Write-Host "Step 6: /v1/websub/renew skipped because WebSubChannelId was not supplied."
}

Write-Host "Cloud smoke complete: token=[redacted], provider=youtube. Only after this should an operator configure/restart radar-channel-monitor in protected mode."
