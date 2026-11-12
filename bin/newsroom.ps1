# Newsroom control CLI for Windows: thin wrapper over docker compose.
#
# Installed by install.ps1 as newsroom.cmd / newsroom.ps1 (see docs/INSTALL.md).
param(
    [Parameter(Position = 0)][string]$Command = 'help',
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)

$ErrorActionPreference = 'Stop'

$lib = Join-Path $PSScriptRoot '../infra/install/lib'
Import-Module (Join-Path $lib 'Newsroom.Core.psm1') -Force
Import-Module (Join-Path $lib 'Newsroom.Install.psm1') -Force

function Show-Usage {
    @'
Newsroom control CLI

Usage:
  newsroom <command> [options]

Commands:
  up                 Build and start the stack
  down               Stop the stack (keeps volumes and data)
  status             Show container status
  logs [service]     Follow logs (use --no-follow to print and exit)
  update             Pull the checkout, rebuild images and apply migrations
  doctor             Check Docker, GPU, models, ports and disk
  models             Download the local models if they are missing
  version            Print the CLI version
  help               Show this help

Options:
  --project-dir <path>   Checkout that holds .env and compose.yaml
  --profile <name>       Override the profile: cpu or gpu
  --dry-run              Print the docker compose command without running it
  -h, --help             Show this help
'@
}

$tokens = @()
if ($Command) { $tokens += $Command }
if ($Rest) { $tokens += $Rest }

$command = ''
$follow = $true
$service = ''
$positional = @()
$projectDir = ''
$profileOverride = ''
$dryRun = $false

$index = 0
while ($index -lt $tokens.Count) {
    $token = [string]$tokens[$index]
    if ($token -eq '--project-dir') {
        $index++
        if ($index -lt $tokens.Count) { $projectDir = [string]$tokens[$index] }
    } elseif ($token -match '^--project-dir=(.+)$') {
        $projectDir = $Matches[1]
    } elseif ($token -eq '--profile') {
        $index++
        if ($index -lt $tokens.Count) { $profileOverride = [string]$tokens[$index] }
    } elseif ($token -match '^--profile=(.+)$') {
        $profileOverride = $Matches[1]
    } elseif ($token -eq '--dry-run') {
        $dryRun = $true
    } elseif ($token -eq '--no-follow') {
        $follow = $false
    } elseif ($token -match '^(-h|--help)$') {
        $command = 'help'
    } elseif ($token -match '^(version|--version)$') {
        $command = 'version'
    } elseif ($token -match '^(up|down|status|logs|update|doctor|models|help)$') {
        $command = $token
    } elseif ($token.StartsWith('-')) {
        Stop-NrInstall "unknown option: $token (use --help)"
    } else {
        $positional += $token
    }
    $index++
}

if (-not $command) {
    if ($positional.Count -gt 0) { Stop-NrInstall "unknown command: $($positional[0]) (use --help)" }
    $command = 'help'
}
if ($positional.Count -gt 0) {
    if ($command -eq 'logs') {
        $service = $positional[0]
    } else {
        Stop-NrInstall "unexpected argument: $($positional[0])"
    }
}

try {
    Initialize-NrPaths -ProjectDir $projectDir
    $config = Get-NrConfig
    Set-NrOption -Name DryRun -Value $dryRun

    $profile = $profileOverride
    if (-not $profile) { $profile = $env:NEWSROOM_PROFILE }
    if (-not $profile -and (Test-Path -LiteralPath $config.EnvFile -PathType Leaf)) {
        $profile = Get-NrEnvValue -Key 'NEWSROOM_PROFILE'
    }
    if (-not $profile) { $profile = 'cpu' }
    if ($profile -eq 'auto') { $profile = 'cpu' }
    Set-NrOption -Name Profile -Value $profile

    function Assert-NrEnv {
        if (-not (Test-Path -LiteralPath $config.EnvFile -PathType Leaf)) {
            Stop-NrInstall "no .env in $($config.ProjectDir); run install.ps1 first"
        }
    }
    function Assert-NrCompose {
        if (-not (Test-Path -LiteralPath $config.ComposeFile -PathType Leaf)) {
            Stop-NrInstall "compose file not found: $($config.ComposeFile)"
        }
    }

    switch ($command) {
        'help' { Show-Usage }
        'version' { Write-Host ("newsroom {0}" -f $(if ($env:NEWSROOM_VERSION) { $env:NEWSROOM_VERSION } else { '0.1.0' })) }
        'up' {
            Assert-NrEnv
            Assert-NrCompose
            $code = Invoke-NrCompose -Arguments @('up', '-d', '--build')
            if ($code -ne 0) { Stop-NrInstall 'the stack failed to start' }
            Write-NrOk "stack is up (profile: $profile)"
        }
        'down' {
            Assert-NrEnv
            Assert-NrCompose
            $code = Invoke-NrCompose -Arguments @('down', '--remove-orphans')
            if ($code -ne 0) { Stop-NrInstall 'the stack failed to stop' }
            Write-NrOk 'stack is stopped'
        }
        'status' {
            Assert-NrEnv
            Assert-NrCompose
            Invoke-NrCompose -Arguments @('ps') | Out-Null
        }
        'logs' {
            Assert-NrEnv
            Assert-NrCompose
            $logArgs = @('logs', '--tail=200')
            if ($follow -and [Environment]::UserInteractive) { $logArgs += '-f' }
            if ($service) { $logArgs += $service }
            Invoke-NrCompose -Arguments $logArgs | Out-Null
        }
        'models' {
            Assert-NrEnv
            Assert-NrCompose
            Install-NrModels
        }
        'update' {
            Assert-NrEnv
            Assert-NrCompose
            $dirty = & git -C $config.RepoRoot status --porcelain
            if ($LASTEXITCODE -ne 0) { Stop-NrInstall 'git is not available; cannot update' }
            if ($dirty) { Stop-NrInstall 'the checkout has uncommitted changes; commit or stash them before updating' }
            & git -C $config.RepoRoot remote get-url origin *> $null
            if ($LASTEXITCODE -eq 0) {
                $code = Invoke-NrExternal -FilePath 'git' -Arguments @('-C', $config.RepoRoot, 'pull', '--ff-only')
                if ($code -ne 0) { Stop-NrInstall 'git pull failed' }
            } else {
                Write-NrWarn 'no git remote configured; skipping git pull'
            }
            Invoke-NrCompose -Arguments @('pull') | Out-Null
            Invoke-NrCompose -Arguments @('build', '--pull') | Out-Null
            Invoke-NrCompose -Arguments @('run', '--rm', 'migrate') | Out-Null
            Invoke-NrCompose -Arguments @('up', '-d') | Out-Null
            Set-NrStateValue -Key 'MIGRATIONS_APPLIED' -Value '1'
            Write-NrOk "update complete (profile: $profile)"
        }
        'doctor' {
            Write-NrInfo 'Newsroom local installer'
            Write-NrInfo "repository: $($config.RepoRoot)"
            Write-NrInfo "project:    $($config.ProjectDir)"
            if (-not (Test-NrEnvironment)) { exit 1 }
            Write-NrOk 'doctor: no blocking problems'
            Write-Host ''
            Write-Host "Installation state ($($config.StateFile)):"
            $state = Read-NrEnvFile -Path $config.StateFile
            if ($state.Count -eq 0) {
                Write-Host '  not installed yet'
            } else {
                foreach ($key in $state.Keys) { Write-Host ("  {0}={1}" -f $key, $state[$key]) }
            }
            if (Test-Path -LiteralPath $config.EnvFile -PathType Leaf) {
                $models = 'pending'
                if ((Get-NrStateValue -Key 'MODELS_DOWNLOADED') -eq '1') { $models = 'downloaded' }
                $admin = 'pending'
                if ((Get-NrStateValue -Key 'ADMIN_CREATED') -eq '1') { $admin = 'initialized' }
                Write-Host ''
                Write-Host "Models: $models"
                Write-Host "Admin:  $admin"
            }
        }
        default { Stop-NrInstall "unknown command: $command (use --help)" }
    }
    exit 0
} catch {
    Write-NrFail ($_.Exception.Message)
    exit 1
}
