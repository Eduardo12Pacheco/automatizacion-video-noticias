$ErrorActionPreference = 'Stop'

. "$PSScriptRoot/load-env.ps1"

function Add-SoxToPath {
  $existing = Get-Command sox -ErrorAction SilentlyContinue
  if ($existing) {
    return
  }

  $projectRoot = Split-Path -Parent $PSScriptRoot
  $n8nRoot = Split-Path -Parent $projectRoot
  $desktopRoot = Split-Path -Parent $n8nRoot
  $userProfile = Split-Path -Parent $desktopRoot

  $candidateRoots = @(
    (Join-Path $userProfile 'AppData\Local\Microsoft\WinGet\Packages'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'),
    $env:ProgramFiles,
    ${env:ProgramFiles(x86)}
  ) | Where-Object { $_ -and (Test-Path $_) }

  foreach ($root in $candidateRoots) {
    $sox = Get-ChildItem -Path $root -Filter sox.exe -Recurse -ErrorAction SilentlyContinue |
      Sort-Object FullName -Descending |
      Select-Object -First 1

    if ($sox) {
      $env:PATH = "$($sox.DirectoryName);$env:PATH"
      return
    }
  }
}

Add-SoxToPath

if (-not (Get-Command sox -ErrorAction SilentlyContinue)) {
  throw "No encuentro sox.exe. Instalá SoX con: winget install --id ChrisBagwell.SoX -e"
}

if (-not $env:TTS_WORKER_INTERNAL_TOKEN) {
  throw "Falta TTS_WORKER_INTERNAL_TOKEN en .env.local"
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

Set-Location $serviceRoot

& $env:TTS_WORKER_PYTHON -m uvicorn voice_tts_service.api.worker_app:app --host 127.0.0.1 --port 8091
