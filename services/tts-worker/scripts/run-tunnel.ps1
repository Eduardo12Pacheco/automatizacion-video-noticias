$ErrorActionPreference = 'Stop'

. "$PSScriptRoot/load-env.ps1"

$configFile = if ($env:TTS_TUNNEL_CONFIG_FILE) {
  $env:TTS_TUNNEL_CONFIG_FILE
}
else {
  Join-Path $env:USERPROFILE '.cloudflared/config.yml'
}

$originCert = if ($env:TTS_TUNNEL_ORIGIN_CERT) {
  $env:TTS_TUNNEL_ORIGIN_CERT
}
else {
  $null
}

if (-not (Test-Path $configFile)) {
  throw "No encontré config.yml del túnel: $configFile"
}

$args = @('--config', $configFile)
if ($originCert) {
  if (-not (Test-Path $originCert)) {
    throw "No encontré cert.pem del túnel: $originCert"
  }
  $args += @('--origincert', $originCert)
}
$args += @('tunnel', 'run')

$cloudflaredCmd = Get-Command cloudflared -ErrorAction SilentlyContinue
if ($cloudflaredCmd) {
  & cloudflared @args
  exit 0
}

$fallback = Join-Path $env:LOCALAPPDATA "Microsoft/WinGet/Packages/Cloudflare.cloudflared_Microsoft.Winget.Source_8wekyb3d8bbwe/cloudflared.exe"
if (Test-Path $fallback) {
  & $fallback @args
  exit 0
}

throw "No encontré cloudflared en PATH ni en ruta fallback."
