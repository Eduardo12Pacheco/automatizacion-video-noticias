$ErrorActionPreference = 'Stop'

$windowsRoot = Split-Path -Parent $PSScriptRoot
$editorWrapper = Get-Content -LiteralPath (Join-Path $windowsRoot 'run-approval-editor-service.ps1') -Raw
$rendererWrapper = Get-Content -LiteralPath (Join-Path $windowsRoot 'run-remotion-editor-api.ps1') -Raw
$installer = Get-Content -LiteralPath (Join-Path $windowsRoot 'install-editor-services.ps1') -Raw

if ($editorWrapper -notmatch "APPROVAL_EDITOR_RENDERER_URL[\s\S]*?'http://127\.0\.0\.1:3041'") {
  throw 'The approval editor must default to the render-only worker on 127.0.0.1:3041.'
}
if ($rendererWrapper -notmatch "RENDER_SERVER_PORT[\s\S]*?'3041'") {
  throw 'The render worker wrapper must default to port 3041.'
}
if ($rendererWrapper -notmatch 'render-server\.js') {
  throw 'The render worker wrapper must start services/renderer/scripts/render/render-server.js.'
}
if ($installer -match 'approval-pipeline-local') {
  throw 'The installer must not reference the removed approval-pipeline-local service.'
}
if (Test-Path -LiteralPath (Join-Path $windowsRoot 'run-approval-pipeline-local.ps1')) {
  throw 'The legacy approval-pipeline-local wrapper must stay deleted.'
}

Write-Host 'editor service defaults OK'
