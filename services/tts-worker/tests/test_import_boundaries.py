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


def test_compatibility_entrypoints_remain_callable() -> None:
    from voice_tts_service.api import orchestrator_app as canonical_orchestrator
    from voice_tts_service.api import worker_app as canonical_worker
    from voice_tts_service.cli import synthesize as canonical_cli

    orchestrator = _load_module(SERVICE_ROOT / "tts-orchestrator" / "app.py", "compat_orchestrator_app")
    worker = _load_module(SERVICE_ROOT / "tts-worker" / "app.py", "compat_worker_app")
    cli = _load_module(SERVICE_ROOT / "src" / "main.py", "compat_tts_cli")

    assert orchestrator.app.title == "tts-orchestrator"
    assert orchestrator.app is canonical_orchestrator.app
    assert orchestrator.create_app is canonical_orchestrator.create_app
    assert "compatibilidad deprecada" in (orchestrator.__doc__ or "").lower()
    assert worker.app.title == "tts-worker"
    assert worker.app is canonical_worker.app
    assert worker.create_app is canonical_worker.create_app
    assert "compatibilidad deprecada" in (worker.__doc__ or "").lower()
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
        assert relative.parts[0] not in {"tts-orchestrator", "tts-worker", "src"}
