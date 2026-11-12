$ErrorActionPreference = "Stop"

$ServiceName = "radar-channel-monitor"
$ServiceRoot = Split-Path -Parent $PSScriptRoot
$ScriptPath = Join-Path $PSScriptRoot "run-service.ps1"
$LogsPath = Join-Path $ServiceRoot "runtime-logs"
$Nssm = "nssm"

New-Item -ItemType Directory -Force -Path $LogsPath | Out-Null

& $Nssm install $ServiceName "powershell.exe" "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`""
& $Nssm set $ServiceName AppDirectory $ServiceRoot
& $Nssm set $ServiceName AppStdout (Join-Path $LogsPath "service.out.log")
& $Nssm set $ServiceName AppStderr (Join-Path $LogsPath "service.err.log")
& $Nssm set $ServiceName Start SERVICE_AUTO_START
& $Nssm set $ServiceName AppRestartDelay 5000

Write-Host "Installed or updated $ServiceName"
