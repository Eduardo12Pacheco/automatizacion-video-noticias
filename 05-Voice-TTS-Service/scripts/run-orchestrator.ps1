$ErrorActionPreference = 'Stop'

. "$PSScriptRoot/load-env.ps1"

if (-not $env:TTS_WORKER_INTERNAL_TOKEN) {
  throw "Falta TTS_WORKER_INTERNAL_TOKEN en .env.local"
}
if (-not $env:TTS_ORCH_FRONTEND_API_KEY) {
  throw "Falta TTS_ORCH_FRONTEND_API_KEY en .env.local"
}
if (-not $env:TTS_ORCH_BASIC_USER) {
  throw "Falta TTS_ORCH_BASIC_USER en .env.local"
}
if (-not $env:TTS_ORCH_BASIC_PASS) {
  throw "Falta TTS_ORCH_BASIC_PASS en .env.local"
}

$env:TTS_ORCH_WORKER_INTERNAL_TOKEN = $env:TTS_WORKER_INTERNAL_TOKEN

$orchestratorDir = Join-Path (Split-Path -Parent $PSScriptRoot) "tts-orchestrator"
Set-Location $orchestratorDir

uvicorn app:app --host 127.0.0.1 --port 8088
