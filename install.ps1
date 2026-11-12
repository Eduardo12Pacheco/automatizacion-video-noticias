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
    [ValidateSet('demo', 'local')][string]$Mode = 'demo',
    [switch]$Gpu,
    [switch]$NoGpu,
    [string]$Port = '',
    [switch]$Check,
    [switch]$DryRun,
    [switch]$Uninstall,
    [switch]$Purge,
    [switch]$ForcePurge,
    [switch]$NoModels,
    [switch]$NoStart,
    [switch]$NoOpen,
    [switch]$Open,
    [switch]$Help,
    [switch]$Version,
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
  -Mode <name>          demo (default) or local: real local AI stack
  -Profile <name>       auto (default), cpu or gpu
  -Gpu                  Use the gpu profile
  -NoGpu                Use the cpu profile even when a GPU is present
  -Port <number>        Published panel port (default 8080)
  -Check                Check host prerequisites and exit
  -DryRun               Print every action without changing the host
  -Uninstall            Stop and remove the stack
  -Purge                With -Uninstall: also delete volumes, models and .env
  -ForcePurge           Skip the typed purge confirmation (non-interactive use)
  -NoModels             Skip downloading the local models
  -NoStart              Prepare the installation but do not start the stack
  -NoOpen               Do not open the panel in a browser
  -BinDir <path>        Where to install the newsroom CLI
  -AdminEmail <email>   First administrator email
  -ProjectDir <path>    Directory holding .env and compose.yaml
  -ComposeFile <path>   Docker Compose file
  -AllowMissingDocker   CI/self-check: warn instead of failing without Docker
  -Help                 Show this help
  -Version              Show the installer version

Environment:
  NEWSROOM_MODE, NEWSROOM_PROFILE, NEWSROOM_PROJECT_DIR, NEWSROOM_COMPOSE_FILE,
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

if ($Version) {
    if ($env:NEWSROOM_VERSION) { $versionText = $env:NEWSROOM_VERSION } else { $versionText = '0.1.0' }
    Write-Host ("newsroom installer {0}" -f $versionText)
    exit 0
}

if ($Gpu -and $NoGpu) {
    Write-NrFail '-Gpu and -NoGpu cannot be combined'
    exit 1
}
if ($Port -and $Port -notmatch '^[0-9]+$') {
    Write-NrFail "invalid -Port: $Port (expected 1-65535)"
    exit 1
}
if ($Port) {
    $portNumber = [int]$Port
    if ($portNumber -lt 1 -or $portNumber -gt 65535) {
        Write-NrFail "invalid -Port: $Port (expected 1-65535)"
        exit 1
    }
}

try {
    Initialize-NrPaths -ProjectDir $ProjectDir -ComposeFile $ComposeFile
    $config = Get-NrConfig
    Set-NrOption -Name Yes -Value ([bool]$Yes)
    Set-NrOption -Name ForcePurge -Value ([bool]$ForcePurge)
    Set-NrOption -Name DryRun -Value ([bool]$DryRun)
    Set-NrOption -Name Mode -Value $Mode
    if ($Port) { Set-NrOption -Name Port -Value $Port }
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

    Write-NrBanner
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

    Write-NrStep -Index 1 -Total 7 -Message 'Checking Docker, host requirements and ports'
    $allowNoDocker = $AllowMissingDocker -and $DryRun
    if (-not $allowNoDocker) {
        if (-not (Test-NrDockerCli)) { Stop-NrInstall 'docker is not installed or not in PATH' }
        if (-not (Test-NrDockerDaemon)) { Stop-NrInstall 'docker daemon is not reachable; start Docker Desktop' }
        if (-not (Test-NrComposeCli)) { Stop-NrInstall 'the docker compose v2 plugin is required' }
    }

    $modeExplicit = $PSBoundParameters.ContainsKey('Mode') -or [bool]$env:NEWSROOM_MODE
    if (-not $PSBoundParameters.ContainsKey('Mode') -and $env:NEWSROOM_MODE) {
        $Mode = $env:NEWSROOM_MODE
        Set-NrOption -Name Mode -Value $Mode
    }
    if (-not $modeExplicit -and -not $DryRun -and (Test-NrInteractive)) {
        Resolve-NrMode -Interactive
        $Mode = $config.Mode
    } else {
        Resolve-NrMode
        $Mode = $config.Mode
    }

    $requestedProfile = $Profile
    if ($Gpu) { $requestedProfile = 'gpu' }
    if ($NoGpu) { $requestedProfile = 'cpu' }
    if (($Gpu -or $NoGpu) -and $PSBoundParameters.ContainsKey('Profile') -and $Profile -ne 'auto' -and $requestedProfile -ne $Profile) {
        Stop-NrInstall "-Gpu/-NoGpu conflict with -Profile $Profile"
    }
    $profileExplicit = $Gpu -or $NoGpu -or $PSBoundParameters.ContainsKey('Profile') -or [bool]$env:NEWSROOM_PROFILE
    if (-not $PSBoundParameters.ContainsKey('Profile') -and -not $Gpu -and -not $NoGpu -and $env:NEWSROOM_PROFILE) {
        $requestedProfile = $env:NEWSROOM_PROFILE
    }
    Resolve-NrProfile -Requested $requestedProfile -Interactive:(-not $profileExplicit -and -not $DryRun -and (Test-NrInteractive))

    Write-NrStep -Index 2 -Total 7 -Message 'Preparing the environment file and run mode'
    if (-not $DryRun) {
        if (-not (Test-Path -LiteralPath $config.ComposeFile -PathType Leaf)) {
            Stop-NrInstall "compose file not found: $($config.ComposeFile)"
        }
        Update-NrEnvFile
        Set-NrEnvValue -Key 'NEWSROOM_PROFILE' -Value $config.Profile
        Set-NrEnvValue -Key 'NEWSROOM_MODE' -Value $Mode
        if ($Port) {
            Set-NrEnvValue -Key 'PANEL_PORT' -Value $Port
            Update-NrPanelOrigins -Port $Port
        }
        if ($Mode -eq 'local' -and $config.Profile -ne 'gpu') {
            $ttsEngine = Get-NrEnvValue -Key 'TTS_WORKER_ENGINE'
            if (-not $ttsEngine -or $ttsEngine -eq 'auto') {
                Set-NrEnvValue -Key 'TTS_WORKER_ENGINE' -Value 'piper'
            }
        }
        if ($Mode -eq 'local') {
            Set-NrEnvValue -Key 'COMPOSE_PROFILES' -Value 'local'
        } else {
            Set-NrEnvValue -Key 'COMPOSE_PROFILES' -Value ''
        }
        if ($AdminEmail) {
            Set-NrEnvValue -Key 'NEWSROOM_ADMIN_EMAIL' -Value $AdminEmail
        }
    } else {
        Write-NrInfo "would create or repair $($config.EnvFile) from $($config.EnvTemplate)"
    }

    Write-NrInfo "installation profile: $($config.Profile)"
    Write-NrInfo "run mode: $Mode"

    Write-NrStep -Index 3 -Total 7 -Message 'Installing the newsroom control CLI'
    Install-NrCli -BinDir $BinDir

    Write-NrStep -Index 4 -Total 7 -Message 'Pulling and building container images'
    $buildCode = Invoke-NrCompose -Arguments @('build', '--pull')
    if ($buildCode -ne 0) { Stop-NrInstall 'image build failed' }

    Write-NrStep -Index 5 -Total 7 -Message 'Preparing local models'
    Install-NrModels

    Write-NrStep -Index 6 -Total 7 -Message 'Applying migrations and creating the administrator'
    Install-NrMigrations
    Install-NrAdmin

    Write-NrStep -Index 7 -Total 7 -Message 'Starting the stack'
    Start-NrStack
    Open-NrPanel
    Write-NrInstallSummary

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
