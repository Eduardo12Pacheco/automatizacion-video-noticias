param(
  [string]$Source = "<WORKSPACE>\Downloads\www.youtube.com_cookies.txt",
  [string]$Destination = "<WORKSPACE>\Desktop\n8n\09-Transcript-Service\secrets\youtube-cookies.txt",
  [switch]$RestartService,
  [string]$ServiceName = "transcript-service-radar"
)

$ErrorActionPreference = "Stop"

if (!(Test-Path -LiteralPath $Source)) {
  throw "Cookies source file was not found: $Source"
}

$sourceInfo = Get-Item -LiteralPath $Source
if ($sourceInfo.Length -le 0) {
  throw "Cookies source file is empty: $Source"
}

$destinationDir = Split-Path -Parent $Destination
if (!(Test-Path -LiteralPath $destinationDir)) {
  New-Item -ItemType Directory -Path $destinationDir -Force | Out-Null
}

Copy-Item -LiteralPath $Source -Destination $Destination -Force

$destinationInfo = Get-Item -LiteralPath $Destination
if ($destinationInfo.Length -le 0) {
  throw "Cookies destination file is empty after copy: $Destination"
}

"YouTube cookies updated: $Destination"

if ($RestartService) {
  nssm restart $ServiceName
}
