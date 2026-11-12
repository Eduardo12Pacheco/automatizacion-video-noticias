$ErrorActionPreference = 'Stop'

. "$PSScriptRoot/load-env.ps1"

foreach ($name in @('TRANSCRIPT_SERVICE_API_KEY')) {
  if (-not [System.Environment]::GetEnvironmentVariable($name, 'Process')) {
    throw "Falta $name en .env"
  }
}

$root = Split-Path -Parent $PSScriptRoot
$defaultPython = Join-Path $root '.venv/Scripts/python.exe'
$venvScripts = Join-Path $root '.venv/Scripts'

$pathEntries = @()
if (Test-Path $venvScripts) {
  $pathEntries += $venvScripts
}

$cudaDllDirs = [System.Environment]::GetEnvironmentVariable('TRANSCRIPT_SERVICE_CUDA_DLL_DIRS', 'Process')
if ($cudaDllDirs) {
  foreach ($entry in ($cudaDllDirs -split ';')) {
    $dir = $entry.Trim()
    if (-not $dir) { continue }

    if (Test-Path -LiteralPath $dir -PathType Container) {
      $pathEntries += $dir
    }
    else {
      Write-Warning "TRANSCRIPT_SERVICE_CUDA_DLL_DIRS path not found, skipping: $dir"
    }
  }
}

if ($pathEntries.Count -gt 0) {
  $env:PATH = (($pathEntries + @($env:PATH)) -join ';')
}

$python = if ($env:TRANSCRIPT_SERVICE_PYTHON) {
  $env:TRANSCRIPT_SERVICE_PYTHON
}
elseif (Test-Path $defaultPython) {
  $defaultPython
}
else {
  'python'
}

$port = if ($env:TRANSCRIPT_SERVICE_PORT) { $env:TRANSCRIPT_SERVICE_PORT } else { '8765' }

Set-Location $root
& $python -m uvicorn app.main:app --host 127.0.0.1 --port $port
