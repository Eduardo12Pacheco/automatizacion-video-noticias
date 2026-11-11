$ErrorActionPreference = 'Stop'

. "$PSScriptRoot/load-env.ps1"

$baseUrl = $env:TRANSCRIPT_SERVICE_BASE_URL
if (-not $baseUrl) {
  $port = if ($env:TRANSCRIPT_SERVICE_PORT) { $env:TRANSCRIPT_SERVICE_PORT } else { '8765' }
  $baseUrl = "http://127.0.0.1:$port"
}

$apiKey = $env:TRANSCRIPT_SERVICE_API_KEY
if (-not $apiKey) {
  throw 'TRANSCRIPT_SERVICE_API_KEY is required for authenticated Radar preflight checks.'
}

Write-Host 'Servicio Windows:'
Get-Service -Name transcript-service-radar -ErrorAction SilentlyContinue | Select-Object Name, Status, StartType | Format-Table -AutoSize

Write-Host 'Liveness público:'
Invoke-RestMethod -Method Get -Uri "$baseUrl/api/radar/live"

Write-Host 'Health autenticado:'
Invoke-RestMethod -Method Get -Uri "$baseUrl/api/radar/health" -Headers @{ "x-api-key" = $apiKey }
