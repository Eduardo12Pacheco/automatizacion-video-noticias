from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parents[1]


def _load_module(path: Path, name: str):
    sys.path.insert(0, str(SERVICE_ROOT))
    sys.path.insert(0, str(path.parent))
    try:
        spec = importlib.util.spec_from_file_location(name, path)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        for value in (str(path.parent), str(SERVICE_ROOT)):
            if value in sys.path:
                sys.path.remove(value)


def test_legacy_fastapi_trees_are_gone_and_only_the_cli_wrapper_remains() -> None:
    from voice_tts_service.cli import synthesize as canonical_cli

    assert not (SERVICE_ROOT / "tts-orchestrator" / "app.py").exists()
    assert not (SERVICE_ROOT / "tts-worker" / "app.py").exists()
    cli = _load_module(SERVICE_ROOT / "src" / "main.py", "compat_tts_cli")

    assert callable(cli.main)
    assert cli.main is canonical_cli.main
    assert cli.parse_args is canonical_cli.parse_args
    assert "compatibilidad deprecada" in (cli.__doc__ or "").lower()


def test_package_modules_do_not_import_legacy_wrapper_modules() -> None:
    import voice_tts_service.api.orchestrator_app as orchestrator_app
    import voice_tts_service.api.worker_app as worker_app
    import voice_tts_service.cli.synthesize as synthesize

    for module in (orchestrator_app, worker_app, synthesize):
        relative = Path(module.__file__).resolve().relative_to(SERVICE_ROOT)
        assert relative.parts[0] not in {"src"}
