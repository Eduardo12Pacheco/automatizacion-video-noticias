# Core helpers for the Windows installer and the newsroom CLI.
#
# Mirror of infra/install/lib/{common,env,host}.sh. PowerShell 5.1 compatible:
# no ternary operators, no null-coalescing, no -AsHashtable.

$script:NrConfig = @{
    RepoRoot       = ''
    ProjectDir     = ''
    EnvFile        = ''
    EnvTemplate    = ''
    ComposeFile    = ''
    StateDir       = ''
    StateFile      = ''
    Profile        = 'auto'
    DryRun         = $false
    Yes            = $false
    DownloadModels = $true
    StartStack     = $true
    OpenPanel      = $false
    BinDir         = ''
    CheckFailures  = 0
    CheckWarnings  = 0
    AllowMissingDocker = $false
    PendingAdminPassword = ''
}

function Get-NrConfig {
    return $script:NrConfig
}

function Get-NrOption {
    param([Parameter(Mandatory = $true)][string]$Name)
    return $script:NrConfig[$Name]
}

function Set-NrOption {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        $Value
    )
    if (-not $script:NrConfig.ContainsKey($Name)) {
        throw "unknown installer option: $Name"
    }
    $script:NrConfig[$Name] = $Value
}

# --- Logging ---------------------------------------------------------------

function Write-NrInfo {
    param([string]$Message)
    Write-Host "[nr] $Message" -ForegroundColor Blue
}

function Write-NrOk {
    param([string]$Message)
    Write-Host "[ok] $Message" -ForegroundColor Green
}

function Write-NrWarn {
    param([string]$Message)
    Write-Host "[warn] $Message" -ForegroundColor Yellow
    $script:NrConfig.CheckWarnings = [int]$script:NrConfig.CheckWarnings + 1
}

function Write-NrFail {
    param([string]$Message)
    Write-Host "[fail] $Message" -ForegroundColor Red
}

function Write-NrCheckFail {
    param([string]$Message)
    Write-NrFail $Message
    $script:NrConfig.CheckFailures = [int]$script:NrConfig.CheckFailures + 1
}

function Stop-NrInstall {
    param([string]$Message)
    Write-NrFail $Message
    throw $Message
}

# --- Paths and options -----------------------------------------------------

function Initialize-NrPaths {
    param(
        [string]$ProjectDir = '',
        [string]$ComposeFile = '',
        [string]$EnvFile = ''
    )
    $lib = $PSScriptRoot
    $repo = [System.IO.Path]::GetFullPath((Join-Path $lib '../../..'))
    if ($ProjectDir -eq '' -and $env:NEWSROOM_PROJECT_DIR) {
        $ProjectDir = $env:NEWSROOM_PROJECT_DIR
    }
    if ($ProjectDir -eq '') {
        $ProjectDir = $repo
    }
    if (-not (Test-Path -LiteralPath $ProjectDir -PathType Container)) {
        Stop-NrInstall "project directory not found: $ProjectDir"
    }
    $resolvedProject = (Resolve-Path -LiteralPath $ProjectDir).ProviderPath

    $script:NrConfig.RepoRoot = $repo
    $script:NrConfig.ProjectDir = $resolvedProject
    if ($EnvFile -eq '' -and $env:NEWSROOM_ENV_FILE) {
        $EnvFile = $env:NEWSROOM_ENV_FILE
    }
    if ($EnvFile -eq '') {
        $EnvFile = Join-Path $resolvedProject '.env'
    }
    if ($ComposeFile -eq '' -and $env:NEWSROOM_COMPOSE_FILE) {
        $ComposeFile = $env:NEWSROOM_COMPOSE_FILE
    }
    if ($ComposeFile -eq '') {
        $ComposeFile = Join-Path $resolvedProject 'compose.yaml'
    }
    $script:NrConfig.EnvFile = $EnvFile
    $script:NrConfig.EnvTemplate = Join-Path $resolvedProject '.env.example'
    $script:NrConfig.ComposeFile = $ComposeFile
    $script:NrConfig.StateDir = Join-Path $resolvedProject '.newsroom'
    $script:NrConfig.StateFile = Join-Path $script:NrConfig.StateDir 'state.env'
}

function Test-NrCommand {
    param([Parameter(Mandatory = $true)][string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

# --- File output -----------------------------------------------------------

# Windows PowerShell 5.1's `Set-Content -Encoding UTF8` writes a BOM, which
# breaks the first key of a .env file for Docker Compose and bash. Always write
# UTF-8 without a BOM.
function Write-NrLinesFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Lines
    )
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllLines($Path, [string[]]@($Lines), $encoding)
}

# --- Secrets ---------------------------------------------------------------

function New-NrSecret {
    param([int]$Bytes = 24)
    $buffer = New-Object 'byte[]' $Bytes
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($buffer)
    } finally {
        $generator.Dispose()
    }
    return ($buffer | ForEach-Object { $_.ToString('x2') }) -join ''
}

function New-NrPassword {
    return (New-NrSecret -Bytes 12)
}

function Read-NrSecret {
    param([string]$Prompt)
    $secure = Read-Host -Prompt $Prompt -AsSecureString
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    } finally {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

# --- Docker Compose --------------------------------------------------------

function Test-NrDockerCli {
    if (-not (Test-NrCommand 'docker')) { return $false }
    & docker --version *> $null
    return ($LASTEXITCODE -eq 0)
}

function Test-NrDockerDaemon {
    if (-not (Test-NrDockerCli)) { return $false }
    & docker info *> $null
    return ($LASTEXITCODE -eq 0)
}

function Test-NrComposeCli {
    if (-not (Test-NrDockerCli)) { return $false }
    & docker compose version *> $null
    return ($LASTEXITCODE -eq 0)
}

function Format-NrCommand {
    param([string[]]$Parts)
    $quoted = foreach ($part in $Parts) {
        if ($part -match '\s') { '"{0}"' -f $part } else { $part }
    }
    return ($quoted -join ' ')
}

function Get-NrComposeArgs {
    param([string[]]$Arguments = @())
    $composeArgs = @('compose')
    if (Test-Path -LiteralPath $script:NrConfig.EnvFile -PathType Leaf) {
        $composeArgs += @('--env-file', $script:NrConfig.EnvFile)
    }
    $composeArgs += @('-f', $script:NrConfig.ComposeFile)
    if ($script:NrConfig.Profile -and $script:NrConfig.Profile -ne 'auto') {
        $composeArgs += @('--profile', $script:NrConfig.Profile)
    }
    $composeArgs += $Arguments
    return $composeArgs
}

function Invoke-NrExternal {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @()
    )
    Write-NrInfo ("run: {0}" -f (Format-NrCommand (@($FilePath) + $Arguments)))
    if ($script:NrConfig.DryRun) { return 0 }
    & $FilePath @Arguments
    if ($null -eq $LASTEXITCODE) { return 0 }
    return $LASTEXITCODE
}

function Invoke-NrCompose {
    param([string[]]$Arguments = @())
    $composeArgs = Get-NrComposeArgs -Arguments $Arguments
    Write-NrInfo ("run: {0}" -f (Format-NrCommand (@('docker') + $composeArgs)))
    if ($script:NrConfig.DryRun) { return 0 }
    Push-Location -LiteralPath $script:NrConfig.ProjectDir
    try {
        & docker @composeArgs
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ($null -eq $code) { return 0 }
    return $code
}

function Invoke-NrComposeWithStdin {
    param(
        [Parameter(Mandatory = $true)][string]$InputText,
        [string[]]$Arguments = @()
    )
    $composeArgs = Get-NrComposeArgs -Arguments $Arguments
    Write-NrInfo ("run: {0} (password on stdin)" -f (Format-NrCommand (@('docker') + $composeArgs)))
    if ($script:NrConfig.DryRun) { return 0 }
    Push-Location -LiteralPath $script:NrConfig.ProjectDir
    try {
        $InputText | & docker @composeArgs
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ($null -eq $code) { return 0 }
    return $code
}

# --- Environment file ------------------------------------------------------

function Read-NrEnvFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    $values = @{}
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $values
    }
    foreach ($raw in Get-Content -LiteralPath $Path) {
        $line = $raw.TrimEnd("`r")
        if ($line -eq '' -or $line.StartsWith('#')) { continue }
        if ($line.StartsWith('export ')) { $line = $line.Substring(7) }
        $index = $line.IndexOf('=')
        if ($index -lt 1) { continue }
        $key = $line.Substring(0, $index)
        $value = $line.Substring($index + 1)
        if ($key -match '^[A-Za-z_][A-Za-z0-9_]*$') {
            $values[$key] = $value
        }
    }
    return $values
}

function Expand-NrEnvTokens {
    param(
        [string]$Value,
        [hashtable]$Values
    )
    foreach ($key in $Values.Keys) {
        $token = '__GENERATE_' + $key + '__'
        if ($Value.Contains($token)) {
            $Value = $Value.Replace($token, [string]$Values[$key])
        }
    }
    if ($Value.Contains('__GENERATE__')) {
        $Value = $Value.Replace('__GENERATE__', (New-NrSecret -Bytes 24))
    }
    return $Value
}

function Update-NrEnvFile {
    $template = $script:NrConfig.EnvTemplate
    $target = $script:NrConfig.EnvFile
    if (-not (Test-Path -LiteralPath $template -PathType Leaf)) {
        Stop-NrInstall "environment template not found: $template"
    }
    $values = Read-NrEnvFile -Path $target
    $templateLines = Get-Content -LiteralPath $template
    $templateKeys = @{}

    foreach ($raw in $templateLines) {
        $line = $raw.TrimEnd("`r")
        if ($line -eq '' -or $line.StartsWith('#')) { continue }
        $index = $line.IndexOf('=')
        if ($index -lt 1) { continue }
        $key = $line.Substring(0, $index)
        $value = $line.Substring($index + 1)
        $templateKeys[$key] = $true
        if (-not $values.ContainsKey($key)) {
            if ($value -eq '__GENERATE__') {
                $values[$key] = New-NrSecret -Bytes 24
            } else {
                $values[$key] = $value
            }
        }
    }
    foreach ($key in @($values.Keys)) {
        $values[$key] = Expand-NrEnvTokens -Value ([string]$values[$key]) -Values $values
    }

    $output = New-Object System.Collections.Generic.List[string]
    foreach ($raw in $templateLines) {
        $line = $raw.TrimEnd("`r")
        if ($line -eq '' -or $line.StartsWith('#')) {
            $output.Add($line)
            continue
        }
        $index = $line.IndexOf('=')
        if ($index -lt 1) {
            $output.Add($line)
            continue
        }
        $key = $line.Substring(0, $index)
        if ($values.ContainsKey($key)) {
            $output.Add($key + '=' + [string]$values[$key])
        } else {
            $output.Add($line)
        }
    }
    foreach ($key in $values.Keys) {
        if (-not $templateKeys.ContainsKey($key)) {
            $output.Add($key + '=' + [string]$values[$key])
        }
    }

    $parent = Split-Path -Parent $target
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    Write-NrLinesFile -Path $target -Lines $output
    # Restrict the generated secrets to the current user.
    if ($env:OS -eq 'Windows_NT') {
        try {
            $acl = Get-Acl -LiteralPath $target
            $acl.SetAccessRuleProtection($true, $false)
            $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
            if ($null -ne $identity -and $identity.Name) {
                $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
                    $identity.Name, 'FullControl', 'Allow')
                $acl.SetAccessRule($rule)
            }
            Set-Acl -LiteralPath $target -AclObject $acl
        } catch {
            Write-NrWarn 'could not restrict .env permissions; verify the ACL manually'
        }
    } else {
        # Development smoke tests on Linux/macOS. FileInfo handles dotfiles,
        # unlike Get-Item in some PowerShell builds.
        try {
            $file = [System.IO.FileInfo]::new($target)
            $file.UnixFileMode = [System.IO.UnixFileMode]::UserRead -bor [System.IO.UnixFileMode]::UserWrite
        } catch { }
    }
    Write-NrOk "environment file ready: $target"
}

function Get-NrEnvValue {
    param([Parameter(Mandatory = $true)][string]$Key)
    $values = Read-NrEnvFile -Path $script:NrConfig.EnvFile
    if ($values.ContainsKey($Key)) { return [string]$values[$Key] }
    return ''
}

function Set-NrEnvValue {
    param(
        [Parameter(Mandatory = $true)][string]$Key,
        [Parameter(Mandatory = $true)][string]$Value
    )
    $path = $script:NrConfig.EnvFile
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return }
    $lines = Get-Content -LiteralPath $path
    $found = $false
    $output = foreach ($raw in $lines) {
        $line = $raw.TrimEnd("`r")
        if ($line.StartsWith($Key + '=')) {
            $found = $true
            $Key + '=' + $Value
        } else {
            $line
        }
    }
    if (-not $found) { $output = @($output) + ($Key + '=' + $Value) }
    Set-Content -LiteralPath $path -Value $output -Encoding UTF8
}

# --- Installation state ----------------------------------------------------

function Get-NrStateValue {
    param([Parameter(Mandatory = $true)][string]$Key)
    $values = Read-NrEnvFile -Path $script:NrConfig.StateFile
    if ($values.ContainsKey($Key)) { return [string]$values[$Key] }
    return ''
}

function Set-NrStateValue {
    param(
        [Parameter(Mandatory = $true)][string]$Key,
        [Parameter(Mandatory = $true)][string]$Value
    )
    if ($script:NrConfig.DryRun) { return }
    if (-not (Test-Path -LiteralPath $script:NrConfig.StateDir)) {
        New-Item -ItemType Directory -Path $script:NrConfig.StateDir -Force | Out-Null
    }
    $values = Read-NrEnvFile -Path $script:NrConfig.StateFile
    $values[$Key] = $Value
    $lines = @()
    foreach ($item in $values.Keys) {
        $lines += ($item + '=' + [string]$values[$item])
    }
    Write-NrLinesFile -Path $script:NrConfig.StateFile -Lines $lines
    if ($env:OS -ne 'Windows_NT') {
        try {
            $stateItem = [System.IO.FileInfo]::new($script:NrConfig.StateFile)
            $stateItem.UnixFileMode = [System.IO.UnixFileMode]::UserRead -bor [System.IO.UnixFileMode]::UserWrite
        } catch { }
    }
}

# --- Hardware --------------------------------------------------------------

function Get-NrFreeDiskMB {
    $path = $script:NrConfig.ProjectDir
    try {
        $full = [System.IO.Path]::GetFullPath($path)
        if (-not $full.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
            $full += [System.IO.Path]::DirectorySeparatorChar
        }
        $drive = New-Object System.IO.DriveInfo($full)
        return [int]($drive.AvailableFreeSpace / 1MB)
    } catch {
        return 0
    }
}

function Get-NrRamMB {
    try {
        $computer = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop
        return [int]($computer.TotalPhysicalMemory / 1MB)
    } catch {
        try {
            $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
            return [int]($os.TotalVisibleMemorySize / 1024)
        } catch {
            # PowerShell on Linux/macOS (development smoke runs).
            try {
                $meminfo = Get-Content -LiteralPath '/proc/meminfo' -ErrorAction Stop
                $line = $meminfo | Where-Object { $_ -match '^MemTotal:\s+(\d+)' } | Select-Object -First 1
                if ($line -match '^MemTotal:\s+(\d+)') { return [int]([int64]$Matches[1] / 1024) }
            } catch { }
            return 0
        }
    }
}

function Test-NrGpuPresent {
    if (-not (Test-NrCommand 'nvidia-smi')) { return $false }
    $output = & nvidia-smi -L 2>$null
    if ($LASTEXITCODE -ne 0) { return $false }
    return [bool]($output -match 'GPU')
}

function Test-NrGpuContainerReady {
    if ($env:OS -ne 'Windows_NT') {
        if (Test-NrCommand 'nvidia-ctk') { return $true }
        if (Test-NrCommand 'nvidia-container-toolkit') { return $true }
        $runtimes = & docker info --format '{{json .Runtimes}}' 2>$null
        return [bool]($runtimes -match 'nvidia')
    }
    # Docker Desktop with the WSL2 backend exposes the GPU through the
    # nvidia-smi driver installed on the Windows host.
    return $true
}

function Resolve-NrProfile {
    param([string]$Requested = 'auto')
    switch ($Requested) {
        'cpu' { $script:NrConfig.Profile = 'cpu' }
        'gpu' { $script:NrConfig.Profile = 'gpu' }
        'auto' {
            if (Test-NrGpuPresent) {
                if (Test-NrGpuContainerReady) {
                    $script:NrConfig.Profile = 'gpu'
                    Write-NrOk "NVIDIA GPU detected, using the gpu profile"
                } else {
                    $script:NrConfig.Profile = 'cpu'
                    Write-NrWarn "NVIDIA GPU detected but the container runtime is missing; using cpu"
                }
            } else {
                $script:NrConfig.Profile = 'cpu'
                Write-NrOk "no NVIDIA GPU detected, using the cpu profile"
            }
        }
        default { Stop-NrInstall "unknown profile: $Requested (expected auto, cpu or gpu)" }
    }
}

function Test-NrPortInUse {
    param([Parameter(Mandatory = $true)][int]$Port)
    try {
        $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
        return [bool]($listeners)
    } catch {
        return $false
    }
}

# --- Checks ----------------------------------------------------------------

function Test-NrEnvironment {
    Write-NrInfo 'checking host prerequisites'
    $script:NrConfig.CheckFailures = 0
    $script:NrConfig.CheckWarnings = 0

    if (Test-NrDockerCli) {
        Write-NrOk ("docker: {0}" -f ((& docker --version) -join ' '))
    } elseif ($script:NrConfig.AllowMissingDocker) {
        Write-NrWarn 'docker is not installed; skipping the Docker-dependent checks'
    } else {
        Write-NrCheckFail 'docker is not installed or not in PATH'
    }
    if (Test-NrComposeCli) {
        Write-NrOk ("docker compose: {0}" -f ((& docker compose version --short) -join ' '))
    } elseif (-not $script:NrConfig.AllowMissingDocker) {
        Write-NrCheckFail 'docker compose v2 plugin is not available'
    }
    if (Test-NrDockerDaemon) {
        Write-NrOk 'docker daemon is reachable'
    } elseif (-not $script:NrConfig.AllowMissingDocker) {
        Write-NrCheckFail 'docker daemon is not reachable (start Docker Desktop)'
    }
    if ($env:OS -eq 'Windows_NT' -and (Test-NrDockerDaemon)) {
        $osType = ((& docker info --format '{{.OSType}}') -join '').Trim()
        if ($osType -and $osType -ne 'linux') {
            Write-NrCheckFail "Docker is using $osType containers; switch Docker Desktop to Linux containers"
        } else {
            Write-NrOk 'Docker is using Linux containers (WSL2 backend)'
        }
    }

    $disk = Get-NrFreeDiskMB
    if ($disk -ge 10240) {
        Write-NrOk "free disk: $disk MB"
    } else {
        Write-NrCheckFail "only $disk MB free; at least 10240 MB is required"
    }
    $ram = Get-NrRamMB
    if ($ram -ge 8192) {
        Write-NrOk "RAM: $ram MB"
    } elseif ($ram -gt 0) {
        Write-NrWarn "only $ram MB RAM; 8192 MB is recommended for the full stack"
    } else {
        Write-NrWarn 'could not determine installed RAM'
    }

    if (Test-NrGpuPresent) {
        $gpuName = ((& nvidia-smi --query-gpu=name --format=csv,noheader) -join ' ').Trim()
        Write-NrOk "NVIDIA GPU: $gpuName"
        if (Test-NrGpuContainerReady) {
            Write-NrOk 'NVIDIA container runtime is available'
        } else {
            Write-NrWarn 'NVIDIA container runtime is missing; the gpu profile will not start'
        }
    } else {
        Write-NrInfo 'NVIDIA GPU: not detected (cpu profile)'
    }

    foreach ($port in @(8080, 8099, 5432, 8888)) {
        if (Test-NrPortInUse -Port $port) {
            Write-NrWarn "port $port is already in use; change it in .env if the stack fails"
        } else {
            Write-NrOk "port $port is free"
        }
    }

    if (Test-Path -LiteralPath $script:NrConfig.ComposeFile -PathType Leaf) {
        Write-NrOk ("compose file: {0}" -f $script:NrConfig.ComposeFile)
    } else {
        Write-NrWarn 'compose file is not available yet'
    }
    if (Test-Path -LiteralPath $script:NrConfig.EnvFile -PathType Leaf) {
        Write-NrOk ("environment file: {0}" -f $script:NrConfig.EnvFile)
    } else {
        Write-NrInfo 'environment file will be created from .env.example'
    }

    if ($script:NrConfig.CheckFailures -gt 0) {
        Write-NrFail ("{0} prerequisite check(s) failed" -f $script:NrConfig.CheckFailures)
        return $false
    }
    Write-NrOk ("prerequisites OK ({0} warning(s))" -f $script:NrConfig.CheckWarnings)
    return $true
}

Export-ModuleMember -Function *
