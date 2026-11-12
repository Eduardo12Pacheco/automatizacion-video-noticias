#!/usr/bin/env bash
# Runs every installer/CLI behaviour test.
#
# PowerShell tests are skipped automatically when no pwsh/powershell binary is
# available; set PWSH_BIN to force a specific interpreter.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
exec python3 -m unittest discover -s . -p 'test_*.py' -v "$@"
