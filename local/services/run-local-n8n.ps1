param(
  [switch]$NoFollowLogs
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$n8nDir = Join-Path $root 'local/n8n'
$dockerDesktop = 'C:/Program Files/Docker/Docker/Docker Desktop.exe'

if (-not (Test-Path (Join-Path $n8nDir 'docker-compose.yml'))) {
  throw "No encontré docker-compose.yml en $n8nDir"
}

function Test-DockerReady {
  try {
    docker info *> $null
    return $LASTEXITCODE -eq 0
  }
  catch {
    return $false
  }
}

if (-not (Test-DockerReady)) {
  if (Test-Path $dockerDesktop) {
    Start-Process -FilePath $dockerDesktop -ErrorAction SilentlyContinue
  }
}

$deadline = (Get-Date).AddMinutes(5)
while (-not (Test-DockerReady)) {
  if ((Get-Date) -gt $deadline) {
    throw 'Docker no quedó listo después de 5 minutos. Revisá Docker Desktop.'
  }
  Start-Sleep -Seconds 5
}

Push-Location $n8nDir
try {
  docker compose up -d
  if (-not $NoFollowLogs) {
    docker compose logs -f n8n
  }
}
finally {
  Pop-Location
}
