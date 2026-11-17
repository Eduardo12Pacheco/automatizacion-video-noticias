$ErrorActionPreference = 'Stop'

$workspaceRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$root = Join-Path $workspaceRoot 'services\approval-editor'
$node = 'C:\Program Files\nodejs\node.exe'

if (-not (Test-Path -LiteralPath $node)) {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $cmd) { throw 'No se encontró node.exe. Instalá Node o corregí la ruta en este wrapper.' }
  $node = $cmd.Source
}

$env:APPROVAL_EDITOR_SERVICE_PORT = if ($env:APPROVAL_EDITOR_SERVICE_PORT) { $env:APPROVAL_EDITOR_SERVICE_PORT } else { '3042' }
$env:APPROVAL_EDITOR_RENDER_ADAPTER = if ($env:APPROVAL_EDITOR_RENDER_ADAPTER) { $env:APPROVAL_EDITOR_RENDER_ADAPTER } else { 'http' }
# The render-only worker owns rendering and runs on 3041; the ASR worker owns
# Whisper and is reached over HTTP, so no Python path is configured here.
$env:APPROVAL_EDITOR_RENDERER_URL = if ($env:APPROVAL_EDITOR_RENDERER_URL) { $env:APPROVAL_EDITOR_RENDERER_URL } else { 'http://127.0.0.1:3041' }

Set-Location -LiteralPath $root
& $node (Join-Path $root 'server.js')
