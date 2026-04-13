$ErrorActionPreference = 'Stop'

. "$PSScriptRoot/load-env.ps1"

if (-not $env:TTS_WORKER_INTERNAL_TOKEN) {
  throw "Falta TTS_WORKER_INTERNAL_TOKEN en .env.local"
}

$defaultPython = Join-Path (Split-Path -Parent $PSScriptRoot) ".venv-qwen/Scripts/python.exe"
if (-not $env:TTS_WORKER_PYTHON) {
  if (Test-Path $defaultPython) {
    $env:TTS_WORKER_PYTHON = $defaultPython
  }
}

if (-not (Test-Path $env:TTS_WORKER_PYTHON)) {
  throw "No encuentro TTS_WORKER_PYTHON. Definilo en .env.local o validá .venv-qwen."
}

$workerDir = Join-Path (Split-Path -Parent $PSScriptRoot) "tts-worker"
Set-Location $workerDir

& $env:TTS_WORKER_PYTHON -m uvicorn app:app --host 127.0.0.1 --port 8091
