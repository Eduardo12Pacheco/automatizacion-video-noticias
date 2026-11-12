"""Wrapper CLI de compatibilidad deprecada para `voice_tts_service.cli.synthesize`.

No borrar sin aprobación manual de runtime: `JobRunner._build_command()` mantiene
este entrypoint para preservar el camino de síntesis existente.
"""

from __future__ import annotations

import sys
from pathlib import Path
SERVICE_ROOT = Path(__file__).resolve().parent.parent
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from voice_tts_service.cli.synthesize import (  # noqa: E402,F401
    analyze_segment_audio,
    load_config,
    main,
    model_output_tag,
    parse_args,
    resolve_generation_with_preset,
)


if __name__ == "__main__":
    main()
