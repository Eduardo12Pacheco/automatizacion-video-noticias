$ErrorActionPreference = "Stop"

$ServiceRoot = Split-Path -Parent $PSScriptRoot
$EnvPath = Join-Path $ServiceRoot ".env"

if (Test-Path -LiteralPath $EnvPath) {
    Get-Content -LiteralPath $EnvPath | ForEach-Object {
        if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
        $name, $value = $_ -split '=', 2
        [Environment]::SetEnvironmentVariable($name.Trim(), $value.Trim().Trim('"'), 'Process')
    }
}

Push-Location -LiteralPath $ServiceRoot
try {
    python -m uvicorn app.main:app --host 127.0.0.1 --port 8775
}
finally {
    Pop-Location
}
