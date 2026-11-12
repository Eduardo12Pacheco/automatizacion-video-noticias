param(
    [Parameter(Mandatory = $true)][string] $ProjectId,
    [Parameter(Mandatory = $true)][string] $Region,
    [Parameter(Mandatory = $true)][string] $ServiceName,
    [Parameter(Mandatory = $true)][string] $Image,
    [Parameter(Mandatory = $true)][string] $ApiTokenSecretRef,
    [Parameter(Mandatory = $true)][string] $YouTubeApiKeySecretRef,
    [Parameter(Mandatory = $true)][string] $WebSubVerifyTokenSecretRef,
    [Parameter(Mandatory = $true)][string] $LocalEventApiKeySecretRef,
    [Parameter(Mandatory = $true)][string] $PublicCallbackUrl,
    [Parameter(Mandatory = $true)][string] $LocalEventUrl,
    [string] $Provider = "youtube",
    [switch] $NoTraffic,
    [switch] $ConfirmDeploy
)

$ErrorActionPreference = "Stop"

function Assert-SecretManagerRef {
    param(
        [Parameter(Mandatory = $true)][string] $Name,
        [Parameter(Mandatory = $true)][string] $Value
    )

    if ($Value -notmatch "^[-a-zA-Z0-9_]+:(latest|[0-9]+)$") {
        throw "Refusing to deploy: $Name must be a Secret Manager reference like secret-name:latest. Do not pass raw token or API key values."
    }
}

if ($Provider -ne "youtube") {
    throw "Refusing to deploy: CHANNEL_BOUNDARY_PROVIDER=youtube is required for the real provider Cloud Run rollout."
}

Assert-SecretManagerRef -Name "CHANNEL_BOUNDARY_API_TOKEN" -Value $ApiTokenSecretRef
Assert-SecretManagerRef -Name "CHANNEL_BOUNDARY_YOUTUBE_API_KEY" -Value $YouTubeApiKeySecretRef
Assert-SecretManagerRef -Name "CHANNEL_BOUNDARY_WEBSUB_VERIFY_TOKEN" -Value $WebSubVerifyTokenSecretRef
Assert-SecretManagerRef -Name "CHANNEL_BOUNDARY_LOCAL_EVENT_API_KEY" -Value $LocalEventApiKeySecretRef

if (-not $PublicCallbackUrl.StartsWith("https://")) {
    throw "Refusing to deploy: CHANNEL_BOUNDARY_PUBLIC_CALLBACK_URL must be an HTTPS public boundary callback URL."
}

if (-not $LocalEventUrl.StartsWith("https://")) {
    throw "Refusing to deploy: CHANNEL_BOUNDARY_LOCAL_EVENT_URL must be an HTTPS forwarding URL."
}

$SetEnvVars = "CHANNEL_BOUNDARY_PROVIDER=youtube,CHANNEL_BOUNDARY_PUBLIC_CALLBACK_URL=$PublicCallbackUrl,CHANNEL_BOUNDARY_LOCAL_EVENT_URL=$LocalEventUrl"
$SetSecrets = "CHANNEL_BOUNDARY_API_TOKEN=$ApiTokenSecretRef,CHANNEL_BOUNDARY_YOUTUBE_API_KEY=$YouTubeApiKeySecretRef,CHANNEL_BOUNDARY_WEBSUB_VERIFY_TOKEN=$WebSubVerifyTokenSecretRef,CHANNEL_BOUNDARY_LOCAL_EVENT_API_KEY=$LocalEventApiKeySecretRef"

$Command = @(
    "run", "deploy", $ServiceName,
    "--project", $ProjectId,
    "--region", $Region,
    "--image", $Image,
    "--set-env-vars", $SetEnvVars,
    "--set-secrets", $SetSecrets
)

if ($NoTraffic) {
    $Command += "--no-traffic"
}

Write-Host "Safe Cloud Run deployment prepared for Channel Network Boundary."
Write-Host "Provider mode: CHANNEL_BOUNDARY_PROVIDER=youtube"
Write-Host "Secrets: using Secret Manager references only; values will not be printed."
Write-Host "Traffic: use -NoTraffic for staged deployment, then smoke the Cloud Run URL before routing traffic."
Write-Host "Operator order: Deploy boundary -> Smoke cloud -> configure/restart radar-channel-monitor in protected mode."

if (-not $ConfirmDeploy) {
    Write-Host "Dry run only. Re-run with -ConfirmDeploy to execute gcloud."
    Write-Host "Command shape: gcloud run deploy <service> --project <project> --region <region> --image <image> --set-env-vars <non-secret-env> --set-secrets <Secret Manager refs>"
    exit 0
}

Write-Host "Executing gcloud without printing secret values."
& gcloud @Command
