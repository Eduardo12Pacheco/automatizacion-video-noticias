param(
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'

function Assert-Admin {
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
  )
  if (-not $isAdmin) {
    throw 'Este script requiere PowerShell ejecutado como Administrador.'
  }
}

function Resolve-NssmPath {
  $cmd = Get-Command nssm -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  $candidates = @(
    'C:\Program Files\nssm\win64\nssm.exe',
    'C:\Program Files\nssm\win32\nssm.exe',
    'C:\nssm\win64\nssm.exe',
    'C:\nssm\win32\nssm.exe'
  )

  $wingetRoot = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
  if (Test-Path -LiteralPath $wingetRoot) {
    $wingetFound = Get-ChildItem -Path $wingetRoot -Filter nssm.exe -Recurse -ErrorAction SilentlyContinue |
      Sort-Object FullName -Descending |
      Select-Object -First 1
    if ($wingetFound) { $candidates += $wingetFound.FullName }
  }

  foreach ($path in $candidates) {
    if ($path -and (Test-Path -LiteralPath $path)) { return $path }
  }

  throw 'No se encontró nssm.exe. Instalalo con: winget install NSSM.NSSM'
}

function Install-OrUpdateService {
  param(
    [Parameter(Mandatory = $true)][string]$Nssm,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$DisplayName,
    [Parameter(Mandatory = $true)][string]$Description,
    [Parameter(Mandatory = $true)][string]$ScriptPath,
    [Parameter(Mandatory = $true)][string]$AppDirectory,
    [Parameter(Mandatory = $true)][string]$LogOut,
    [Parameter(Mandatory = $true)][string]$LogErr
  )

  $existing = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host "Actualizando servicio existente: $Name"
    & $Nssm stop $Name | Out-Null
  }
  else {
    Write-Host "Instalando servicio nuevo: $Name"
    & $Nssm install $Name 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' | Out-Null
  }

  & $Nssm set $Name AppParameters "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`"" | Out-Null
  & $Nssm set $Name AppDirectory $AppDirectory | Out-Null
  & $Nssm set $Name DisplayName $DisplayName | Out-Null
  & $Nssm set $Name Description $Description | Out-Null
  & $Nssm set $Name AppStdout $LogOut | Out-Null
  & $Nssm set $Name AppStderr $LogErr | Out-Null
  & $Nssm set $Name AppRotateFiles 1 | Out-Null
  & $Nssm set $Name AppRotateOnline 1 | Out-Null
  & $Nssm set $Name AppRotateSeconds 86400 | Out-Null
  & $Nssm set $Name AppRotateBytes 10485760 | Out-Null
  & $Nssm set $Name AppExit Default Restart | Out-Null
  & $Nssm set $Name Start SERVICE_AUTO_START | Out-Null
  & sc.exe failure $Name reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null
  & sc.exe failureflag $Name 1 | Out-Null
}

Assert-Admin

$scriptsDir = $PSScriptRoot
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptsDir)
$logsDir = Join-Path $scriptsDir 'logs'
New-Item -ItemType Directory -Path $logsDir -Force | Out-Null

$nssm = Resolve-NssmPath
Write-Host "NSSM: $nssm"

Install-OrUpdateService `
  -Nssm $nssm `
  -Name 'remotion-editor-api' `
  -DisplayName 'Remotion Local Editor API' `
  -Description 'Render-only HTTP worker for the approval editor en 127.0.0.1:3041' `
  -ScriptPath (Join-Path $scriptsDir 'run-remotion-editor-api.ps1') `
  -AppDirectory $repoRoot `
  -LogOut (Join-Path $logsDir 'remotion-editor-api.out.log') `
  -LogErr (Join-Path $logsDir 'remotion-editor-api.err.log')

Install-OrUpdateService `
  -Nssm $nssm `
  -Name 'approval-editor-service' `
  -DisplayName 'Approval Editor Service' `
  -Description 'Approval editor snapshots and final-render orchestration en 127.0.0.1:3042' `
  -ScriptPath (Join-Path $scriptsDir 'run-approval-editor-service.ps1') `
  -AppDirectory $repoRoot `
  -LogOut (Join-Path $logsDir 'approval-editor-service.out.log') `
  -LogErr (Join-Path $logsDir 'approval-editor-service.err.log')

if (-not $NoStart) {
  Start-Service remotion-editor-api
  Start-Sleep -Seconds 2
  Start-Service approval-editor-service
}

Get-Service -Name remotion-editor-api, approval-editor-service |
  Select-Object Name, Status, StartType |
  Format-Table -AutoSize

Write-Host 'Servicios del editor instalados/actualizados correctamente.'
