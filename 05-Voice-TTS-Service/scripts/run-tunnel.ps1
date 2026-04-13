$ErrorActionPreference = 'Stop'

$cloudflaredCmd = Get-Command cloudflared -ErrorAction SilentlyContinue
if ($cloudflaredCmd) {
  cloudflared tunnel run voice-lab-tunnel
  exit 0
}

$fallback = "<WORKSPACE>/AppData/Local/Microsoft/WinGet/Packages/Cloudflare.cloudflared_Microsoft.Winget.Source_8wekyb3d8bbwe/cloudflared.exe"
if (Test-Path $fallback) {
  & $fallback tunnel run voice-lab-tunnel
  exit 0
}

throw "No encontré cloudflared en PATH ni en ruta fallback."
