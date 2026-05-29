$ErrorActionPreference = 'Stop'

# Loads TRANSCRIPT_SERVICE_API_KEY from .env and runs uvicorn with --port 8765 via run-service.ps1.
& "$PSScriptRoot/run-service.ps1"
