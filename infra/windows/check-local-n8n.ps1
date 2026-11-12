$ErrorActionPreference = 'Stop'

$checks = @(
  @{ Name = 'local'; Url = 'http://127.0.0.1:5678/healthz' },
  @{ Name = 'public'; Url = 'https://n8n.example.local/healthz' }
)

foreach ($check in $checks) {
  try {
    $res = Invoke-WebRequest $check.Url -UseBasicParsing -TimeoutSec 15
    "{0}: OK ({1})" -f $check.Name, [int]$res.StatusCode
  }
  catch {
    "{0}: FAIL - {1}" -f $check.Name, $_.Exception.Message
  }
}

docker ps --filter "name=local-n8n" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
Get-ScheduledTask -TaskName 'Local Automation Stack Startup' -ErrorAction SilentlyContinue | Select-Object TaskName,State
