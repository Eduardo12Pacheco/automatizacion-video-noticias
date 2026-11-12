# Newsroom local installer for Windows 10/11 (PowerShell 5.1+ and 7+).
#
# Idempotent: re-running repairs the stack and upgrades images without touching
# generated secrets or resetting the administrator password.
#
# Usage: powershell -ExecutionPolicy Bypass -File .\install.ps1
#        pwsh -File ./install.ps1 -Yes -Profile cpu
[CmdletBinding()]
param(
    [switch]$Yes,
    [ValidateSet('auto', 'cpu', 'gpu')][string]$Profile = 'auto',
    [switch]$Check,
    [switch]$DryRun,
    [switch]$Uninstall,
    [switch]$Purge,
    [switch]$NoModels,
    [switch]$NoStart,
    [switch]$NoOpen,
    [switch]$Open,
    [switch]$Help,
    [switch]$AllowMissingDocker,
    [string]$BinDir = '',
    [string]$AdminEmail = '',
    [string]$ProjectDir = '',
    [string]$ComposeFile = ''
)

$ErrorActionPreference = 'Stop'

$lib = Join-Path $PSScriptRoot 'infra/install/lib'
Import-Module (Join-Path $lib 'Newsroom.Core.psm1') -Force
Import-Module (Join-Path $lib 'Newsroom.Install.psm1') -Force

function Show-Usage {
    @'
Newsroom local installer (Windows)

Usage:
  .\install.ps1 [options]

Options:
  -Yes                  Non-interactive; generate the admin password
  -Profile <name>       auto (default), cpu or gpu
  -Check                Check host prerequisites and exit
  -DryRun               Print every action without changing the host
  -Uninstall            Stop and remove the stack
  -Purge                With -Uninstall: also delete volumes, models and .env
  -NoModels             Skip downloading the local models
  -NoStart              Prepare the installation but do not start the stack
  -NoOpen               Do not open the panel in a browser
  -BinDir <path>        Where to install the newsroom CLI
  -AdminEmail <email>   First administrator email
  -ProjectDir <path>    Directory holding .env and compose.yaml
  -ComposeFile <path>   Docker Compose file
  -AllowMissingDocker   CI/self-check: warn instead of failing without Docker
  -Help                 Show this help

Environment:
  NEWSROOM_PROFILE, NEWSROOM_PROJECT_DIR, NEWSROOM_COMPOSE_FILE,
  NEWSROOM_ADMIN_EMAIL, NEWSROOM_ADMIN_PASSWORD, NEWSROOM_BIN_DIR

The installer never reads or writes API keys. It creates .env from
.env.example with fresh random secrets and installs the first administrator
through the API container.
'@
}

if ($Help) {
    Show-Usage
    exit 0
}

try {
    Initialize-NrPaths -ProjectDir $ProjectDir -ComposeFile $ComposeFile
    $config = Get-NrConfig
    Set-NrOption -Name Yes -Value ([bool]$Yes)
    Set-NrOption -Name DryRun -Value ([bool]$DryRun)
    Set-NrOption -Name DownloadModels -Value (-not [bool]$NoModels)
    Set-NrOption -Name StartStack -Value (-not [bool]$NoStart)
    Set-NrOption -Name OpenPanel -Value ([bool]$Open)
    Set-NrOption -Name AllowMissingDocker -Value ([bool]$AllowMissingDocker)
    if ($BinDir) { Set-NrOption -Name BinDir -Value $BinDir }
    if ($env:NEWSROOM_BIN_DIR -and -not $BinDir) { Set-NrOption -Name BinDir -Value $env:NEWSROOM_BIN_DIR }
    if ($AdminEmail) { $env:NEWSROOM_ADMIN_EMAIL = $AdminEmail }

    if (-not $NoOpen -and -not $Yes -and [Environment]::UserInteractive -and -not $env:CI) {
        Set-NrOption -Name OpenPanel -Value $true
    }

    Write-NrInfo 'Newsroom local installer'
    Write-NrInfo "repository: $($config.RepoRoot)"
    Write-NrInfo "project:    $($config.ProjectDir)"
    if ($DryRun) {
        Write-NrInfo 'dry-run: no files, containers, volumes or models will be changed'
    }

    if ($Check) {
        if (Test-NrEnvironment) { exit 0 }
        exit 1
    }

    if ($Uninstall) {
        $envProfile = Get-NrEnvValue -Key 'NEWSROOM_PROFILE'
        if ($envProfile) { Set-NrOption -Name Profile -Value $envProfile }
        Remove-NrStack -Purge:([bool]$Purge)
        exit 0
    }

    $allowNoDocker = $AllowMissingDocker -and $DryRun
    if (-not $allowNoDocker) {
        if (-not (Test-NrDockerCli)) { Stop-NrInstall 'docker is not installed or not in PATH' }
        if (-not (Test-NrDockerDaemon)) { Stop-NrInstall 'docker daemon is not reachable; start Docker Desktop' }
        if (-not (Test-NrComposeCli)) { Stop-NrInstall 'the docker compose v2 plugin is required' }
    }

    Resolve-NrProfile -Requested $Profile

    if (-not $DryRun) {
        if (-not (Test-Path -LiteralPath $config.ComposeFile -PathType Leaf)) {
            Stop-NrInstall "compose file not found: $($config.ComposeFile)"
        }
        Update-NrEnvFile
        Set-NrEnvValue -Key 'NEWSROOM_PROFILE' -Value $config.Profile
        if ($AdminEmail) {
            Set-NrEnvValue -Key 'NEWSROOM_ADMIN_EMAIL' -Value $AdminEmail
        }
    } else {
        Write-NrInfo "would create or repair $($config.EnvFile) from $($config.EnvTemplate)"
    }

    Write-NrInfo "installation profile: $($config.Profile)"

    Install-NrCli -BinDir $BinDir

    Write-NrInfo 'pulling and building images'
    $buildCode = Invoke-NrCompose -Arguments @('build', '--pull')
    if ($buildCode -ne 0) { Stop-NrInstall 'image build failed' }

    Install-NrModels
    Install-NrMigrations
    Install-NrAdmin
    Start-NrStack
    Open-NrPanel
    Write-NrGeneratedAdminPassword

    if ($DryRun) {
        Write-NrOk 'dry-run complete; re-run without -DryRun to install'
    } else {
        Write-NrOk 'installation complete'
    }
    exit 0
} catch {
    Write-NrFail ($_.Exception.Message)
    exit 1
}
