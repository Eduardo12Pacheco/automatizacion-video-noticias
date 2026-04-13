$ErrorActionPreference = 'Stop'

. "$PSScriptRoot/load-env.ps1"

if (-not $env:TTS_WORKER_INTERNAL_TOKEN) {
  throw "Falta TTS_WORKER_INTERNAL_TOKEN en .env.local"
}

$workerDir = Join-Path (Split-Path -Parent $PSScriptRoot) "tts-worker"
Set-Location $workerDir

uvicorn app:app --host 127.0.0.1 --port 8091
