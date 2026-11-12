$ErrorActionPreference = 'Stop'

$workspaceRoot = '<WORKSPACE>\Desktop\n8n'
$root = Join-Path $workspaceRoot 'apps/panel\services\approval-editor'
$videoEngineRoot = Join-Path $workspaceRoot 'services/renderer'
$node = 'C:\Program Files\nodejs\node.exe'
$python = '<WORKSPACE>\AppData\Local\Programs\Python\Python311\python.exe'

if (-not (Test-Path -LiteralPath $node)) {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $cmd) { throw 'No se encontró node.exe. Instalá Node o corregí la ruta en este wrapper.' }
  $node = $cmd.Source
}

$env:APPROVAL_EDITOR_SERVICE_PORT = if ($env:APPROVAL_EDITOR_SERVICE_PORT) { $env:APPROVAL_EDITOR_SERVICE_PORT } else { '3042' }
$env:APPROVAL_EDITOR_RENDER_ADAPTER = if ($env:APPROVAL_EDITOR_RENDER_ADAPTER) { $env:APPROVAL_EDITOR_RENDER_ADAPTER } else { '02-video-engine' }
$env:APPROVAL_EDITOR_VIDEO_ENGINE_ROOT = if ($env:APPROVAL_EDITOR_VIDEO_ENGINE_ROOT) { $env:APPROVAL_EDITOR_VIDEO_ENGINE_ROOT } else { $videoEngineRoot }
$env:APPROVAL_EDITOR_PYTHON_BIN = if ($env:APPROVAL_EDITOR_PYTHON_BIN) { $env:APPROVAL_EDITOR_PYTHON_BIN } elseif (Test-Path -LiteralPath $python) { $python } else { '' }
$env:REMOTION_EDITOR_PYTHON_BIN = if ($env:REMOTION_EDITOR_PYTHON_BIN) { $env:REMOTION_EDITOR_PYTHON_BIN } elseif ($env:APPROVAL_EDITOR_PYTHON_BIN) { $env:APPROVAL_EDITOR_PYTHON_BIN } else { '' }

if (-not $env:APPROVAL_EDITOR_PYTHON_BIN) {
  throw 'No se encontró Python para alineación Whisper. Corregí $python en este wrapper o definí APPROVAL_EDITOR_PYTHON_BIN.'
}

Set-Location -LiteralPath $root
& $node (Join-Path $root 'server.js')
