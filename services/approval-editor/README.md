# Approval Editor Service

Local service for Approval-owned editor snapshots. The active service boundary is `services/approval-editor/` and it keeps the runtime contract `approval-editor-service-v1`, default port `3042`, `/health`, `/api/*`, and `/api/overlays/*` unchanged.

The service talks to `services/renderer` over HTTP through `APPROVAL_EDITOR_RENDERER_URL`; it never imports renderer files or spawns its CLI.

It requires real Whisper alignment by default; estimated timings only run when `ALLOW_ESTIMATED_TIMINGS=true` is explicitly set.

## RTX 4060 / faster-whisper large-v3

```powershell
$env:APPROVAL_EDITOR_SERVICE_PORT = "3042"
$env:STT_WHISPER_MODEL = "<MODEL_PATH>"
$env:STT_WHISPER_DEVICE = "cuda"
$env:STT_WHISPER_COMPUTE_TYPE = "float16"
$env:REMOTION_EDITOR_PYTHON_BIN = "<PYTHON_EXE>"
# Optional only if ffmpeg-static is not available from services/renderer/node_modules:
# $env:FFMPEG_PATH = "C:\path\to\ffmpeg.exe"
node .\services\approval-editor\server.js
```

For NSSM/service usage, do not rely on the Windows `py` launcher. Services can run as `LocalSystem` or another non-interactive account that cannot see the current user's Python launcher registry. Configure `REMOTION_EDITOR_PYTHON_BIN` or `APPROVAL_EDITOR_PYTHON_BIN` with the full Python 3.11 `python.exe` path, then restart the Approval Editor service so the environment is reloaded.

If CUDA transcription fails, the service retries `cpu/int8` once. If real alignment still fails, `/api/projects/create-from-approval` returns `alignmentStatus.status = "failed"` and the browser client refuses to enter the editor with fake ready timings.

## Focused checks

From the repository root:

```powershell
node --check .\services\approval-editor\server.js
node --test .\services\approval-editor\test\*.test.js .\services\approval-editor\__checks__\*.mjs
node .\apps\panel\js\modules\__checks__\approval-editor-service-timings.check.cjs
pytest .\apps\panel\tests\test_approval_editor_service_boundary_cleanup.py
```

## Runtime projects data

`services/approval-editor/projects/` is local runtime data and remains ignored by git. Snapshots from older layouts are not read automatically; copy them into `services/approval-editor/projects/` before starting the service.
