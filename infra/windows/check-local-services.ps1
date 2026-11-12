param(
  [int]$TimeoutSec = 5
)

$ErrorActionPreference = 'Continue'
$allOk = $true

function Read-DotEnvFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path
  )

  $vars = @{}
  if (-not (Test-Path -LiteralPath $Path)) {
    return $vars
  }

  foreach ($line in [System.IO.File]::ReadLines($Path)) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#') -or $trimmed -notmatch '=') {
      continue
    }

    $parts = $trimmed -split '=', 2
    $name = $parts[0].Trim()
    $value = $parts[1].Trim().Trim('"').Trim("'")
    $vars[$name] = $value
  }

  return $vars
}

$services = @(
  'ImageDownloaderService',
  'tts-worker',
  'tts-orchestrator',
  'tts-tunnel',
  'subtitles-remote-api',
  'remotion-editor-api',
  'approval-pipeline-local',
  'approval-editor-service'
)

Write-Host '=== Servicios Windows locales ==='
foreach ($serviceName in $services) {
  $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  if (-not $service) {
    Write-Host "${serviceName}: NOT INSTALLED" -ForegroundColor Yellow
    $script:allOk = $false
    continue
  }

  $color = if ($service.Status -eq 'Running' -and $service.StartType -eq 'Automatic') { 'Green' } elseif ($service.Status -eq 'Running') { 'Yellow' } else { 'Red' }
  Write-Host "${serviceName}: $($service.Status) (StartType=$($service.StartType))" -ForegroundColor $color
  if ($service.Status -ne 'Running' -or $service.StartType -ne 'Automatic') {
    $script:allOk = $false
  }
}

Write-Host "`n=== Health endpoints ==="
$checks = @(
  @{ Name = 'image-downloader'; Url = 'http://127.0.0.1:8080/health' },
  @{ Name = 'tts-worker'; Url = 'http://127.0.0.1:8091/internal/healthz' },
  @{ Name = 'tts-orchestrator'; Url = 'http://127.0.0.1:8088/healthz' },
  @{ Name = 'tts-public'; Url = 'https://tts-api.example.local/healthz' },
  @{ Name = 'remotion-editor-api'; Url = 'http://127.0.0.1:3037/api/projects' },
  @{ Name = 'approval-pipeline-local'; Url = 'http://127.0.0.1:3041/health' },
  @{ Name = 'approval-editor-service'; Url = 'http://127.0.0.1:3042/health' }
)

foreach ($check in $checks) {
  try {
    $response = Invoke-WebRequest -Uri $check.Url -UseBasicParsing -TimeoutSec $TimeoutSec
    Write-Host "$($check.Name): OK ($($response.StatusCode)) -> $($check.Url)" -ForegroundColor Green
  }
  catch {
    Write-Host "$($check.Name): FAIL -> $($_.Exception.Message)" -ForegroundColor Red
    $script:allOk = $false
  }
}

Write-Host "`n=== Health autenticado: subtítulos ==="
$workspaceRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$subtitlesEnvPath = Join-Path $workspaceRoot 'services/subtitles/.env.local'
$subtitlesEnv = Read-DotEnvFile -Path $subtitlesEnvPath
$subtitlesPort = if ($subtitlesEnv['SUBTITLES_REMOTE_PORT']) { $subtitlesEnv['SUBTITLES_REMOTE_PORT'] } else { '8092' }
$subtitlesUser = $subtitlesEnv['SUBTITLES_REMOTE_BASIC_USER']
$subtitlesPass = $subtitlesEnv['SUBTITLES_REMOTE_BASIC_PASS']
$subtitlesKey = $subtitlesEnv['SUBTITLES_REMOTE_API_KEY']

if (-not $subtitlesUser -or -not $subtitlesPass -or -not $subtitlesKey) {
  Write-Host "subtitles-remote-api: FAIL -> faltan credenciales en $subtitlesEnvPath" -ForegroundColor Red
  $allOk = $false
}
else {
  try {
    $basic = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$subtitlesUser`:$subtitlesPass"))
    $url = "http://127.0.0.1:$subtitlesPort/api/subtitles/health"
    $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec $TimeoutSec -Headers @{
      'x-api-key' = $subtitlesKey
      'Authorization' = "Basic $basic"
    }
    Write-Host "subtitles-remote-api: OK ($($response.StatusCode)) -> $url" -ForegroundColor Green
  }
  catch {
    Write-Host "subtitles-remote-api: FAIL -> $($_.Exception.Message)" -ForegroundColor Red
    $allOk = $false
  }
}

Write-Host "`n=== Dependencias locales críticas ==="
$approvalEditorPython = "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe"
if (-not (Test-Path -LiteralPath $approvalEditorPython)) {
  Write-Host "approval-editor-python: FAIL -> no existe $approvalEditorPython" -ForegroundColor Red
  $allOk = $false
}
else {
  try {
    $pythonCheck = & $approvalEditorPython -c "import importlib.util; raise SystemExit(0 if importlib.util.find_spec('faster_whisper') else 1)" 2>&1
    if ($LASTEXITCODE -eq 0) {
      Write-Host "approval-editor-python: OK -> faster_whisper disponible en $approvalEditorPython" -ForegroundColor Green
    }
    else {
      Write-Host "approval-editor-python: FAIL -> faster_whisper no disponible ($pythonCheck)" -ForegroundColor Red
      $allOk = $false
    }
  }
  catch {
    Write-Host "approval-editor-python: FAIL -> $($_.Exception.Message)" -ForegroundColor Red
    $allOk = $false
  }
}

$videoEngineNodeModules = Join-Path $workspaceRoot 'services/renderer/node_modules'
if (Test-Path -LiteralPath $videoEngineNodeModules) {
  Write-Host "video-engine-node-modules: OK -> $videoEngineNodeModules" -ForegroundColor Green
}
else {
  Write-Host "video-engine-node-modules: FAIL -> falta $videoEngineNodeModules" -ForegroundColor Red
  $allOk = $false
}

Write-Host "`n=== Resultado final ==="
if ($allOk) {
  Write-Host 'TODO OK: servicios locales running, automáticos y health checks correctos.' -ForegroundColor Green
  exit 0
}

Write-Host 'Hay algo para revisar: al menos un servicio o health check falló.' -ForegroundColor Red
exit 1
