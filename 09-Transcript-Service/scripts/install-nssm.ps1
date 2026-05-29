$ErrorActionPreference = 'Stop'

# Compatibility wrapper. install-service.ps1 validates .env/TRANSCRIPT_SERVICE_API_KEY and configures uvicorn --port 8765.
& "$PSScriptRoot/install-service.ps1"
