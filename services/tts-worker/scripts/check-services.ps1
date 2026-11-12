param(
  [string]$HealthUrl = 'http://127.0.0.1:8088/healthz',
  [int]$TimeoutSec = 10
)

$ErrorActionPreference = 'Stop'

$services = @('tts-worker', 'tts-orchestrator')
$allOk = $true

Write-Host '=== Servicios Windows (TTS) ==='
foreach ($serviceName in $services) {
  $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue

  if (-not $service) {
    Write-Host "${serviceName}: NOT FOUND" -ForegroundColor Red
    $allOk = $false
    continue
  }

  if ($service.Status -eq 'Running') {
    Write-Host "${serviceName}: RUNNING (StartType=$($service.StartType))" -ForegroundColor Green
  }
  else {
    Write-Host "${serviceName}: $($service.Status) (StartType=$($service.StartType))" -ForegroundColor Yellow
    $allOk = $false
  }
}

Write-Host "`n=== Local health ==="
try {
  $response = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec $TimeoutSec
  if ($response.StatusCode -eq 200 -and $response.Content -match '"ok"\s*:\s*true') {
    Write-Host "healthz: OK (200) -> $HealthUrl" -ForegroundColor Green
  }
  else {
    Write-Host "healthz: respuesta inesperada ($($response.StatusCode)) -> $HealthUrl" -ForegroundColor Yellow
    $allOk = $false
  }
}
catch {
  Write-Host "healthz: FAIL -> $($_.Exception.Message)" -ForegroundColor Red
  $allOk = $false
}

Write-Host "`n=== Resultado final ==="
if ($allOk) {
  Write-Host "TODO OK: ya podés usar 'Creación de audios'." -ForegroundColor Green
  exit 0
}

Write-Host 'Hay algo para revisar antes de usar producción.' -ForegroundColor Red
exit 1
