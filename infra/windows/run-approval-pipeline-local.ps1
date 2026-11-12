$ErrorActionPreference = 'Stop'

$root = '<WORKSPACE>\Desktop\n8n\services/renderer'
$node = 'C:\Program Files\nodejs\node.exe'

if (-not (Test-Path -LiteralPath $node)) {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $cmd) { throw 'No se encontró node.exe. Instalá Node o corregí la ruta en este wrapper.' }
  $node = $cmd.Source
}

if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules'))) {
  throw "Falta node_modules en $root. Ejecutá: npm install"
}

$env:APPROVAL_PIPELINE_LOCAL_SERVICE_PORT = if ($env:APPROVAL_PIPELINE_LOCAL_SERVICE_PORT) { $env:APPROVAL_PIPELINE_LOCAL_SERVICE_PORT } else { '3041' }
Set-Location -LiteralPath $root
& $node 'scripts/approval-pipeline-local-service.js'
