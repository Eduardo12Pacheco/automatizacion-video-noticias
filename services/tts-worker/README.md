# Voice TTS Service

Local speech synthesis for the newsroom pipeline. `voice_tts_service` is the
only implementation: a FastAPI worker runs Qwen3-TTS (or Piper on CPU), and a
FastAPI orchestrator exposes the job API to the Control Panel.

## Layout

```text
services/tts-worker/
  voice_tts_service/     # API, application, CLI, config, domain, infrastructure
  scripts/               # Windows service install/run/check helpers
  tests/                 # deterministic contracts; no model execution
  config/default.yaml    # voice and generation defaults
  refs/                  # local voice reference (not shipped)
  src/main.py            # deprecated CLI wrapper, kept for old commands only
```

Worker state (jobs database, inputs, outputs and segments) lives under
`runtime/` paths configured by `TTS_WORKER_RUNTIME_DIR`; nothing is committed.

## Entrypoints

```powershell
python -m uvicorn voice_tts_service.api.worker_app:app --host 127.0.0.1 --port 8091
python -m uvicorn voice_tts_service.api.orchestrator_app:app --host 127.0.0.1 --port 8088
```

The CLI lives in `voice_tts_service.cli.synthesize`; `python src/main.py` still
forwards to it for backward compatibility and will be removed in a future
cleanup.

## Windows services

Run PowerShell as Administrator:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
& "$env:NEWSROOM_ROOT\services\tts-worker\scripts\install-services.ps1"
```

This installs and starts `tts-worker` and `tts-orchestrator`. The obsolete
Cloudflare tunnel script and the old `tts-worker/` and `tts-orchestrator/`
compatibility application trees were removed; everything runs through the
package above.

## Checks

```bash
uv run --project services/tts-worker --with pytest pytest services/tts-worker/tests -q
```

The suite covers API/worker contracts, runtime paths, entrypoint cleanup and
the sensitive defaults in `config/default.yaml`. Do not run Qwen/CUDA/SoX
generation in automated tests unless a real smoke test is explicitly needed.

## Sensitive defaults

Do not change these without an explicit voice-quality review: `config/default.yaml`,
the presets (`balanced_default`, `golazo_emotivo`, `golazo_informativo`),
segmentation, assembly, sample rate and the artifact paths.
