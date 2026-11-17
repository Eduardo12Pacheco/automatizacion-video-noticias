# Approval Editor Service

Local service for Approval-owned editor snapshots. The active service boundary is `services/approval-editor/` and it keeps the runtime contract `approval-editor-service-v1`, default port `3042`, `/health`, `/api/*`, and `/api/overlays/*` unchanged.

The service talks to the render-only worker over HTTP through `APPROVAL_EDITOR_RENDERER_URL`; it never imports renderer files or spawns its CLI.

It requires real Whisper alignment by default; estimated timings only run when `ALLOW_ESTIMATED_TIMINGS=true` is explicitly set. The service downloads the voice audio, writes a 16 kHz mono derivative and calls the ASR worker over HTTP (`ASR_WORKER_URL`, `TRANSCRIPT_SERVICE_API_KEY`); it never spawns Whisper or a Python script. In Compose both services mount the same media volume and `APPROVAL_EDITOR_ALIGNMENT_ROOT` points at it.

## ASR worker and ffmpeg

```powershell
$env:APPROVAL_EDITOR_SERVICE_PORT = "3042"
$env:ASR_WORKER_URL = "http://127.0.0.1:8765"
$env:TRANSCRIPT_SERVICE_API_KEY = "<ASR_TOKEN>"
# Optional when ffmpeg is not on PATH:
# $env:FFMPEG_PATH = "C:\path\to\ffmpeg.exe"
node .\services\approval-editor\server.js
```

For NSSM/service usage, run the render-only worker wrapper and the approval editor wrapper from `infra/windows/`. The editor points at the renderer on `http://127.0.0.1:3041` by default; the ASR worker owns the Whisper model, GPU slot and CPU fallback. If real alignment fails, `/api/projects/create-from-approval` returns `alignmentStatus.status = "failed"` and the browser client refuses to enter the editor with fake ready timings.

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
