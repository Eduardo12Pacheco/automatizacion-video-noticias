$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$n8nScript = Join-Path $root 'infra/windows/run-local-n8n.ps1'
$checkScript = Join-Path $root 'infra/windows/check-local-n8n.ps1'

& $n8nScript -NoFollowLogs

try {
  Start-Service control-panel-api-gateway -ErrorAction SilentlyContinue
  Start-Service tts-tunnel -ErrorAction SilentlyContinue
}
catch {
  # Services may already be running or require elevation. n8n startup is the critical path here.
}

& $checkScript
