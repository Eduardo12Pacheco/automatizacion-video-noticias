$ErrorActionPreference = 'Stop'

$serviceName = 'local-n8n'
$displayName = 'Local n8n'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$scriptPath = Join-Path $root 'infra/windows/run-local-n8n.ps1'
$logsDir = Join-Path $root 'runtime-logs/services'

if (-not (Test-Path $scriptPath)) {
  throw "No encontré script de arranque: $scriptPath"
}

New-Item -ItemType Directory -Force -Path $logsDir | Out-Null

$nssm = Get-Command nssm -ErrorAction SilentlyContinue
if (-not $nssm) {
  $candidate = 'C:/nssm/win64/nssm.exe'
  if (Test-Path $candidate) {
    $nssmPath = $candidate
  }
  else {
    throw 'No encontré NSSM. Instalá NSSM o agregalo al PATH antes de registrar local-n8n.'
  }
}
else {
  $nssmPath = $nssm.Source
}

$existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if (-not $existing) {
  & $nssmPath install $serviceName 'powershell.exe' '-NoProfile' '-ExecutionPolicy' 'Bypass' '-File' $scriptPath
}

& $nssmPath set $serviceName DisplayName $displayName | Out-Null
& $nssmPath set $serviceName Description 'Runs local n8n via Docker Compose on Windows startup.' | Out-Null
& $nssmPath set $serviceName AppDirectory $root | Out-Null
& $nssmPath set $serviceName AppStdout (Join-Path $logsDir 'local-n8n.out.log') | Out-Null
& $nssmPath set $serviceName AppStderr (Join-Path $logsDir 'local-n8n.err.log') | Out-Null
& $nssmPath set $serviceName Start SERVICE_AUTO_START | Out-Null
& $nssmPath set $serviceName AppThrottle 1500 | Out-Null
& $nssmPath set $serviceName AppRestartDelay 5000 | Out-Null

Start-Service $serviceName
Get-Service -Name $serviceName | Select-Object Name,Status,StartType
