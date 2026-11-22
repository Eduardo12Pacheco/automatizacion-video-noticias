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
    GpuComposeFile = ''
    StateDir       = ''
    StateFile      = ''
    Profile        = 'auto'
    Mode           = 'demo'
    DryRun         = $false
    Yes            = $false
    ForcePurge     = $false
    DownloadModels = $true
    StartStack     = $true
    OpenPanel      = $false
    BinDir         = ''
    CheckFailures  = 0
    CheckWarnings  = 0
    AllowMissingDocker = $false
    PendingAdminPassword = ''
    PendingAdminEmail = ''
    AdminState = 'none'
    Port = ''
    StepIndex = 0
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

function Write-NrBanner {
    Write-Host ''
    Write-Host '+--------------------------------------------------------------+' -ForegroundColor Blue
    Write-Host '|  Newsroom - local-first news video pipeline                   |' -ForegroundColor Blue
    Write-Host '|  demo or local mode - no API keys required                    |' -ForegroundColor Blue
    Write-Host '+--------------------------------------------------------------+' -ForegroundColor Blue
    Write-Host ''
}

function Write-NrStep {
    param(
        [Parameter(Mandatory = $true)][int]$Index,
        [Parameter(Mandatory = $true)][int]$Total,
        [Parameter(Mandatory = $true)][string]$Message
    )
    $script:NrConfig.StepIndex = $Index
    Write-Host ("[{0}/{1}] {2}" -f $Index, $Total, $Message) -ForegroundColor Blue
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
    if ($env:NEWSROOM_GPU_COMPOSE_FILE) {
        $script:NrConfig.GpuComposeFile = $env:NEWSROOM_GPU_COMPOSE_FILE
    } else {
        $script:NrConfig.GpuComposeFile = Join-Path $repo 'infra/compose/compose.gpu.yaml'
    }
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
    $encoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
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

# Probes docker and reports only its exit code. Windows PowerShell 5.1 turns a
# native command's stderr into a terminating error while the installer runs with
# $ErrorActionPreference = 'Stop', so a stopped daemon ("failed to connect to the
# docker API") would abort the whole prerequisite check instead of failing it.
function Invoke-NrDockerProbe {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & docker @Arguments *> $null
        return ($LASTEXITCODE -eq 0)
    } finally {
        $ErrorActionPreference = $previousPreference
    }
}

function Test-NrDockerCli {
    if (-not (Test-NrCommand 'docker')) { return $false }
    return (Invoke-NrDockerProbe -Arguments @('--version'))
}

function Test-NrDockerDaemon {
    if (-not (Test-NrDockerCli)) { return $false }
    return (Invoke-NrDockerProbe -Arguments @('info'))
}

function Test-NrComposeCli {
    if (-not (Test-NrDockerCli)) { return $false }
    return (Invoke-NrDockerProbe -Arguments @('compose', 'version'))
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
    if ($script:NrConfig.Profile -eq 'gpu') {
        if (-not (Test-Path -LiteralPath $script:NrConfig.GpuComposeFile -PathType Leaf)) {
            throw "gpu profile needs the compose overlay at $($script:NrConfig.GpuComposeFile)"
        }
        $composeArgs += @('-f', $script:NrConfig.GpuComposeFile)
    }
    if ($script:NrConfig.Profile -and $script:NrConfig.Profile -ne 'auto') {
        $composeArgs += @('--profile', $script:NrConfig.Profile)
    }
    if ($script:NrConfig.Mode -eq 'local' -and (($Arguments -join ' ') -notmatch '--profile\s+local')) {
        $composeArgs += @('--profile', 'local')
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
    Set-NrPrivateAcl -Path $target -Windows:($env:OS -eq 'Windows_NT')
    Write-NrOk "environment file ready: $target"
}

# Restricts the generated secrets file to the current user. A failure is an
# install error, never a warning: an .env readable by other accounts leaks every
# secret the installer generated. `AclWriter` exists so the behaviour is
# testable with a failing writer.
function Set-NrPrivateAcl {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [switch]$Windows,
        [scriptblock]$AclWriter
    )
    if ($Windows) {
        $writer = $AclWriter
        if ($null -eq $writer) {
            $writer = {
                param([string]$Target)
                $acl = Get-Acl -LiteralPath $Target
                $acl.SetAccessRuleProtection($true, $false)
                $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
                if ($null -ne $identity -and $identity.Name) {
                    $rule = New-Object -TypeName System.Security.AccessControl.FileSystemAccessRule `
                        -ArgumentList @($identity.Name, 'FullControl', 'Allow')
                    $acl.SetAccessRule($rule)
                }
                Set-Acl -LiteralPath $Target -AclObject $acl
            }
        }
        try {
            & $writer $Path
        } catch {
            Stop-NrInstall ("could not restrict .env permissions: {0}" -f $_.Exception.Message)
        }
        return
    }
    # Development smoke tests on Linux/macOS. FileInfo handles dotfiles, unlike
    # Get-Item in some PowerShell builds.
    $file = [System.IO.FileInfo]::new($Path)
    $file.UnixFileMode = [System.IO.UnixFileMode]::UserRead -bor [System.IO.UnixFileMode]::UserWrite
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
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value
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
    Write-NrLinesFile -Path $path -Lines $output
}

# --- Panel proxy network ---------------------------------------------------

function Convert-NrIpv4ToInt {
    param([string]$Address)
    $parts = $Address.Split('.')
    if ($parts.Count -ne 4) { return $null }
    $value = [uint32]0
    foreach ($part in $parts) {
        $octet = 0
        if (-not [int]::TryParse($part, [ref]$octet)) { return $null }
        if ($octet -lt 0 -or $octet -gt 255) { return $null }
        $value = [uint32]((([uint64]$value) -shl 8) -bor [uint64]$octet)
    }
    return $value
}

function Test-NrCidrOverlap {
    param([string]$Left, [string]$Right)
    if (-not $Left.Contains('/') -or -not $Right.Contains('/')) { return $false }
    $leftParts = $Left.Split('/')
    $rightParts = $Right.Split('/')
    $leftPrefix = 0
    $rightPrefix = 0
    if (-not [int]::TryParse($leftParts[1], [ref]$leftPrefix)) { return $false }
    if (-not [int]::TryParse($rightParts[1], [ref]$rightPrefix)) { return $false }
    if ($leftPrefix -lt 0 -or $leftPrefix -gt 32 -or $rightPrefix -lt 0 -or $rightPrefix -gt 32) { return $false }
    $leftInt = Convert-NrIpv4ToInt -Address $leftParts[0]
    $rightInt = Convert-NrIpv4ToInt -Address $rightParts[0]
    if ($null -eq $leftInt -or $null -eq $rightInt) { return $false }
    $prefix = [Math]::Min($leftPrefix, $rightPrefix)
    if ($prefix -eq 0) {
        $mask = [uint32]0
    } else {
        $mask = [uint32]((0xFFFFFFFFL -shl (32 - $prefix)) -band 0xFFFFFFFFL)
    }
    return (($leftInt -band $mask) -eq ($rightInt -band $mask))
}

function Test-NrPanelSubnetInUse {
    param([string]$Candidate)
    $project = if ($env:COMPOSE_PROJECT_NAME) { $env:COMPOSE_PROJECT_NAME } else { 'newsroom' }
    $exclude = "${project}_panelnet"
    $names = @(& docker network ls --format '{{.Name}}' 2>$null)
    foreach ($name in $names) {
        $trimmed = ([string]$name).Trim()
        if (-not $trimmed -or $trimmed -eq $exclude) { continue }
        $subnets = @(& docker network inspect --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' $trimmed 2>$null)
        foreach ($line in $subnets) {
            foreach ($subnet in ([string]$line -split '\s+')) {
                if ($subnet -and (Test-NrCidrOverlap -Left $Candidate -Right $subnet)) { return $true }
            }
        }
    }
    return $false
}

function Update-NrPanelNetwork {
    $currentSubnet = Get-NrEnvValue -Key 'NEWSROOM_PANEL_SUBNET'
    $currentIp = Get-NrEnvValue -Key 'NEWSROOM_PANEL_IP'
    $candidates = @(
        '172.28.240.0/24', '172.29.240.0/24', '172.30.240.0/24', '172.31.240.0/24',
        '172.27.240.0/24', '172.26.240.0/24', '172.25.240.0/24', '172.24.240.0/24',
        '10.253.240.0/24', '10.252.240.0/24'
    )
    $subnet = ''
    if ($currentSubnet -match '^[0-9.]+/24$' -and -not (Test-NrPanelSubnetInUse -Candidate $currentSubnet)) {
        $subnet = $currentSubnet
    }
    if (-not $subnet) {
        foreach ($candidate in $candidates) {
            if (-not (Test-NrPanelSubnetInUse -Candidate $candidate)) { $subnet = $candidate; break }
        }
    }
    if (-not $subnet) { Stop-NrInstall 'could not find a free /24 for the panel proxy network' }
    $ip = ''
    if ($currentIp -and (Test-NrCidrOverlap -Left "$currentIp/32" -Right $subnet)) {
        $ip = $currentIp
    } else {
        $octets = $subnet.Split('/')[0].Split('.')
        $ip = "$($octets[0]).$($octets[1]).$($octets[2]).$([int]$octets[3] + 10)"
    }
    Set-NrEnvValue -Key 'NEWSROOM_PANEL_SUBNET' -Value $subnet
    Set-NrEnvValue -Key 'NEWSROOM_PANEL_IP' -Value $ip
    Set-NrEnvValue -Key 'TRUSTED_PROXY_CIDRS' -Value "$ip/32"
    Write-NrInfo "panel proxy network: $subnet (trusted proxy $ip)"
}

# --- Installation state ----------------------------------------------------

function Update-NrPanelOrigins {
    param([Parameter(Mandatory = $true)][string]$Port)
    foreach ($key in @('API_GATEWAY_ALLOWED_ORIGINS', 'API_GATEWAY_TRUSTED_MUTATION_ORIGINS', 'PANEL_PUBLIC_ORIGIN')) {
        $value = Get-NrEnvValue -Key $key
        if (-not $value) { continue }
        $updated = $value.Replace('http://127.0.0.1:8080', "http://127.0.0.1:$Port")
        $updated = $updated.Replace('http://localhost:8080', "http://localhost:$Port")
        if ($updated -ne $value) {
            Set-NrEnvValue -Key $key -Value $updated
        }
    }
}

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
    if ($env:NEWSROOM_DISK_MB_OVERRIDE) {
        $override = 0
        if ([int]::TryParse($env:NEWSROOM_DISK_MB_OVERRIDE, [ref]$override) -and $override -ge 0) {
            return $override
        }
        Write-NrWarn 'ignoring NEWSROOM_DISK_MB_OVERRIDE (expected a number of megabytes)'
    }
    $path = $script:NrConfig.ProjectDir
    try {
        $full = [System.IO.Path]::GetFullPath($path)
        if (-not $full.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
            $full += [System.IO.Path]::DirectorySeparatorChar
        }
        $drive = New-Object -TypeName System.IO.DriveInfo -ArgumentList $full
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

function Test-NrGpuOverlayRequired {
    return ($script:NrConfig.Profile -eq 'gpu')
}

function Test-NrGpuPassthrough {
    if (-not (Test-NrGpuOverlayRequired)) { return $false }
    $image = $env:NEWSROOM_GPU_PROBE_IMAGE
    if (-not $image) { $image = 'nvidia/cuda:12.4.1-base-ubuntu22.04' }
    & docker run --rm --gpus all $image nvidia-smi -L *> $null
    return ($LASTEXITCODE -eq 0)
}

function Resolve-NrProfile {
    param(
        [string]$Requested = 'auto',
        [switch]$Interactive
    )
    if ($Interactive -and $Requested -eq 'auto' -and (Test-NrGpuPresent) -and (Test-NrGpuContainerReady)) {
        Write-NrInfo 'NVIDIA GPU detected and the container runtime is ready.'
        $answer = Read-Host -Prompt 'Use the GPU profile? [Y/n]'
        if ($answer -match '^(n|no)$') {
            $Requested = 'cpu'
        } else {
            $Requested = 'gpu'
        }
    }
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

function Resolve-NrMode {
    param([switch]$Interactive)
    if ($Interactive) {
        Write-NrInfo 'Choose the run mode:'
        Write-NrInfo '  demo  - instant, deterministic stubs, no model download (default)'
        Write-NrInfo '  local - real Ollama, Whisper and Piper models on this machine'
        do {
            $answer = Read-Host -Prompt 'Run mode [demo/local] (demo)'
            if (-not $answer) { $answer = 'demo' }
            if ($answer -ne 'demo' -and $answer -ne 'local') {
                Write-NrWarn 'please answer demo or local'
            }
        } while ($answer -ne 'demo' -and $answer -ne 'local')
        $script:NrConfig.Mode = $answer
    }
    if ($script:NrConfig.Mode -ne 'demo' -and $script:NrConfig.Mode -ne 'local') {
        Stop-NrInstall "unknown mode: $($script:NrConfig.Mode) (expected demo or local)"
    }
}

function Test-NrPortInUse {
    param([Parameter(Mandatory = $true)][int]$Port)
    if ($env:NEWSROOM_LISTENING_PORTS_OVERRIDE) {
        $ports = @($env:NEWSROOM_LISTENING_PORTS_OVERRIDE -split ',' | ForEach-Object { $_.Trim() })
        return [bool]($ports -contains [string]$Port)
    }
    try {
        $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
        return [bool]($listeners)
    } catch {
        return $false
    }
}

function Get-NrRunMode {
    $mode = $script:NrConfig.Mode
    if (-not $mode) { $mode = Get-NrEnvValue -Key 'NEWSROOM_MODE' }
    if ($mode -ne 'local') { $mode = 'demo' }
    return $mode
}

function Get-NrRequiredDiskMB {
    if ((Get-NrRunMode) -eq 'local') { return 10240 }
    return 2048
}

function Test-NrStackPublishesPort {
    param([Parameter(Mandatory = $true)][int]$Port)
    if (-not (Test-Path -LiteralPath $script:NrConfig.EnvFile -PathType Leaf)) { return $false }
    if (-not (Test-NrDockerCli)) { return $false }
    try {
        $output = (& docker (Get-NrComposeArgs -Arguments @('ps', '--format', 'json')) 2>$null) -join "`n"
    } catch {
        return $false
    }
    if (-not $output) { return $false }
    return [bool]([regex]::IsMatch($output, '"PublishedPort"\s*:\s*' + $Port + '([^0-9]|$)'))
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
            $engineMessage = "Docker is using $osType containers; switch Docker Desktop to Linux containers"
            if ($script:NrConfig.AllowMissingDocker) {
                # CI self-check mode (-AllowMissingDocker): a Docker engine that
                # cannot run the Linux stack is as unusable as a missing one, so
                # warn like the other Docker-dependent checks. Without the flag a
                # real user is still told to switch and the check fails.
                Write-NrWarn "$engineMessage (continuing because -AllowMissingDocker was given)"
            } else {
                Write-NrCheckFail $engineMessage
            }
        } else {
            Write-NrOk 'Docker is using Linux containers (WSL2 backend)'
        }
    }

    $modeLabel = Get-NrRunMode
    $requiredDisk = Get-NrRequiredDiskMB
    $disk = Get-NrFreeDiskMB
    if ($disk -ge $requiredDisk) {
        Write-NrOk "free disk: $disk MB ($modeLabel mode needs $requiredDisk MB)"
    } else {
        Write-NrCheckFail "only $disk MB free; $modeLabel mode needs at least $requiredDisk MB for images and models"
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
    } elseif (Test-NrGpuOverlayRequired) {
        Write-NrCheckFail 'GPU passthrough: the gpu profile is selected but nvidia-smi is not available'
    } else {
        Write-NrInfo 'NVIDIA GPU: not detected (cpu profile)'
    }

    if (Test-NrGpuOverlayRequired) {
        if ((Test-NrDockerDaemon) -and (Test-NrGpuPassthrough)) {
            Write-NrOk 'GPU passthrough: nvidia-smi runs inside a container'
        } elseif (-not $script:NrConfig.AllowMissingDocker) {
            Write-NrCheckFail "GPU passthrough failed: install nvidia-container-toolkit and run 'docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi'"
        }
    } elseif (Test-NrGpuPresent) {
        Write-NrInfo 'GPU passthrough: not checked (cpu profile; use --profile gpu)'
    }

    $portKeys = @('PANEL_PORT', 'API_GATEWAY_PORT', 'POSTGRES_PORT', 'SEARXNG_PORT')
    $portDefaults = @('8080', '8099', '5432', '8888')
    for ($i = 0; $i -lt $portKeys.Count; $i++) {
        $portValue = Get-NrEnvValue -Key $portKeys[$i]
        if ($i -eq 0 -and $script:NrConfig.Port) { $portValue = $script:NrConfig.Port }
        if (-not $portValue) { $portValue = $portDefaults[$i] }
        $port = 0
        if (-not [int]::TryParse($portValue, [ref]$port)) { $port = [int]$portDefaults[$i] }
        if (Test-NrPortInUse -Port $port) {
            if (Test-NrStackPublishesPort -Port $port) {
                Write-NrOk "port $port is published by this Compose stack"
            } else {
                Write-NrWarn "port $port is already in use; change it in .env if the stack fails"
            }
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
