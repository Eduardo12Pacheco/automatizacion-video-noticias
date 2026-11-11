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
  if ($cmd) {
    return $cmd.Source
  }

  $candidates = @(
    'C:\Program Files\nssm\win64\nssm.exe',
    'C:\Program Files\nssm\win32\nssm.exe',
    'C:\nssm\win64\nssm.exe',
    'C:\nssm\win32\nssm.exe'
  )

  $wingetRoot = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
  if (Test-Path $wingetRoot) {
    $wingetFound = Get-ChildItem -Path $wingetRoot -Filter nssm.exe -Recurse -ErrorAction SilentlyContinue |
      Sort-Object FullName -Descending |
      Select-Object -First 1
    if ($wingetFound) {
      $candidates += $wingetFound.FullName
    }
  }

  foreach ($path in $candidates) {
    if ($path -and (Test-Path $path)) {
      return $path
    }
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
    [Parameter(Mandatory = $true)][string]$LogErr,
    [string]$Dependency = $null
  )

  $existing = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host "Actualizando servicio existente: $Name"
    & $Nssm stop $Name | Out-Null
  }
  else {
    Write-Host "Instalando servicio nuevo: $Name"
    & $Nssm install $Name "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" | Out-Null
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

  if ($Dependency) {
    & sc.exe config $Name depend= $Dependency | Out-Null
  }

  & sc.exe failure $Name reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null
  & sc.exe failureflag $Name 1 | Out-Null
}

Assert-Admin

$root = Split-Path -Parent $PSScriptRoot
$logsDir = Join-Path $root 'runtime-logs\services'
New-Item -ItemType Directory -Path $logsDir -Force | Out-Null

$nssm = Resolve-NssmPath
Write-Host "NSSM: $nssm"

$workerScript = Join-Path $PSScriptRoot 'run-worker.ps1'
$orchestratorScript = Join-Path $PSScriptRoot 'run-orchestrator.ps1'
$tunnelScript = Join-Path $PSScriptRoot 'run-tunnel.ps1'

Install-OrUpdateService -Nssm $nssm -Name 'tts-worker' -DisplayName 'TTS Worker (RTX local)' -Description 'Worker FastAPI para jobs TTS locales con CUDA' -ScriptPath $workerScript -AppDirectory $root -LogOut (Join-Path $logsDir 'tts-worker.out.log') -LogErr (Join-Path $logsDir 'tts-worker.err.log')
Install-OrUpdateService -Nssm $nssm -Name 'tts-orchestrator' -DisplayName 'TTS Orchestrator API' -Description 'API pública FastAPI para encolar y consultar jobs TTS' -ScriptPath $orchestratorScript -AppDirectory $root -LogOut (Join-Path $logsDir 'tts-orchestrator.out.log') -LogErr (Join-Path $logsDir 'tts-orchestrator.err.log') -Dependency 'tts-worker'
Install-OrUpdateService -Nssm $nssm -Name 'tts-tunnel' -DisplayName 'TTS Cloudflare Tunnel' -Description 'Publica la API TTS local por Cloudflare Tunnel' -ScriptPath $tunnelScript -AppDirectory $root -LogOut (Join-Path $logsDir 'tts-tunnel.out.log') -LogErr (Join-Path $logsDir 'tts-tunnel.err.log') -Dependency 'tts-orchestrator'

Start-Service tts-worker
Start-Sleep -Seconds 2
Start-Service tts-orchestrator
Start-Sleep -Seconds 2
Start-Service tts-tunnel

Get-Service -Name tts-worker, tts-orchestrator, tts-tunnel | Select-Object Name, Status, StartType | Format-Table -AutoSize
Write-Host 'Servicios instalados/actualizados correctamente.'
