$ErrorActionPreference = 'Stop'

$root = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'apps/panel'
$node = 'C:\Program Files\nodejs\node.exe'

if (-not (Test-Path -LiteralPath $node)) {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $cmd) { throw 'No se encontró node.exe. Instalá Node o corregí la ruta en este wrapper.' }
  $node = $cmd.Source
}

$env:REMOTION_EDITOR_API_PORT = if ($env:REMOTION_EDITOR_API_PORT) { $env:REMOTION_EDITOR_API_PORT } else { '3037' }
$env:APPROVAL_EDITOR_SERVICE_PORT = $env:REMOTION_EDITOR_API_PORT
$env:APPROVAL_EDITOR_RENDER_ADAPTER = if ($env:APPROVAL_EDITOR_RENDER_ADAPTER) { $env:APPROVAL_EDITOR_RENDER_ADAPTER } else { '02-video-engine' }
Set-Location -LiteralPath $root
& $node 'services/approval-editor/server.js'
