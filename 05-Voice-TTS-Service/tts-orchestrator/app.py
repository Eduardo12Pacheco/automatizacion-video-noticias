"""Wrapper de compatibilidad deprecada para `voice_tts_service.api.orchestrator_app`.

No borrar sin aprobación manual de runtime: comandos legacy todavía pueden usar
`tts-orchestrator/app.py` como fallback mientras los scripts canónicos usan el paquete.
"""

from __future__ import annotations

import sys
from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parent.parent
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from voice_tts_service.api.orchestrator_app import app, create_app  # noqa: E402,F401
