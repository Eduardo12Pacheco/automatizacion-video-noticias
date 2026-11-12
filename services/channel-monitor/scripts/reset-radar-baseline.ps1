param(
  [ValidateSet('dry-run','apply')]
  [string]$Mode = 'dry-run',
  [string]$BaseUrl = 'http://127.0.0.1:8790',
  [string]$ApiKey = $env:CHANNEL_MONITOR_API_KEY,
  [string]$DbPath = $env:CHANNEL_MONITOR_DB_PATH,
  [string]$BackupPath,
  [string]$BaselineStartedAt
)

$ErrorActionPreference = 'Stop'

$ServiceRoot = Split-Path -Parent $PSScriptRoot
$EnvPath = Join-Path $ServiceRoot '.env'

if (Test-Path -LiteralPath $EnvPath) {
  Get-Content -LiteralPath $EnvPath | ForEach-Object {
    if ($_ -match '^\s*([^#][^=]+)\s*=\s*(.*)\s*$') {
      $name = $matches[1].Trim()
      $value = $matches[2].Trim().Trim('"')
      if ($name -and -not [Environment]::GetEnvironmentVariable($name, 'Process')) {
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
      }
    }
  }
}

if (-not $ApiKey) { $ApiKey = $env:CHANNEL_MONITOR_API_KEY }
if (-not $DbPath) { $DbPath = $env:CHANNEL_MONITOR_DB_PATH }

if (-not $DbPath) {
  $DbPath = Join-Path $ServiceRoot 'runtime\monitor.sqlite3'
}

if (-not $BaselineStartedAt) {
  $BaselineStartedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
}

if (-not $BackupPath) {
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
  $BackupPath = "$DbPath.baseline-$stamp.bak"
}

if ($Mode -eq 'apply') {
  if (-not (Test-Path -LiteralPath $DbPath)) {
    throw "Database not found: $DbPath"
  }
  $backupParent = Split-Path -Parent $BackupPath
  if ($backupParent -and -not (Test-Path -LiteralPath $backupParent)) {
    New-Item -ItemType Directory -Path $backupParent | Out-Null
  }
  Copy-Item -LiteralPath $DbPath -Destination $BackupPath -Force
}

$body = @{
  mode = $Mode
  backup_path = $BackupPath
  baseline_started_at = $BaselineStartedAt
}

if ($Mode -eq 'apply') {
  $body.confirm = 'RESET_RADAR_BASELINE'
}

$headers = @{ Accept = 'application/json' }
if ($ApiKey) {
  $headers['x-api-key'] = $ApiKey
}

$uri = ($BaseUrl.TrimEnd('/')) + '/api/monitor/radar-baseline-reset'
Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -ContentType 'application/json' -Body ($body | ConvertTo-Json -Compress)
