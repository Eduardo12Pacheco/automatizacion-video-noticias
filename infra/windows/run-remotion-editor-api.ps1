$ErrorActionPreference = 'Stop'

$root = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) ''
$node = 'C:\Program Files\nodejs\node.exe'

if (-not (Test-Path -LiteralPath $node)) {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $cmd) { throw 'No se encontró node.exe. Instalá Node o corregí la ruta en este wrapper.' }
  $node = $cmd.Source
}

# Render-only HTTP worker used by the approval editor. It listens on loopback
# and requires the shared internal token (RENDERER_API_KEY).
$env:RENDER_SERVER_HOST = if ($env:RENDER_SERVER_HOST) { $env:RENDER_SERVER_HOST } else { '127.0.0.1' }
$env:RENDER_SERVER_PORT = if ($env:RENDER_SERVER_PORT) { $env:RENDER_SERVER_PORT } else { '3041' }
Set-Location -LiteralPath $root
& $node 'services/renderer/scripts/render/render-server.js'
