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

$serviceRoot = Split-Path -Parent $PSScriptRoot
$defaultPython = Join-Path $serviceRoot ".venv-qwen/Scripts/python.exe"
if (-not $env:TTS_WORKER_PYTHON) {
  if (Test-Path $defaultPython) {
    $env:TTS_WORKER_PYTHON = $defaultPython
  }
}

if (-not (Test-Path $env:TTS_WORKER_PYTHON)) {
  throw "No encuentro TTS_WORKER_PYTHON. Definilo en .env.local o validá .venv-qwen."
}

$env:TTS_ORCH_WORKER_INTERNAL_TOKEN = $env:TTS_WORKER_INTERNAL_TOKEN

Set-Location $serviceRoot

& $env:TTS_WORKER_PYTHON -m uvicorn voice_tts_service.api.orchestrator_app:app --host 127.0.0.1 --port 8088
