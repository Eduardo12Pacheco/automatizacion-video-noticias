# Transcript Service Radar

Backend local de Investigación/Radar. Recibe links de video, descarga audio, transcribe con Whisper, busca menciones y genera un TXT para revisión.

## Estado local

- Servicio NSSM: `transcript-service-radar`
- Local: `http://127.0.0.1:8765`
- Liveness público: `GET /api/radar/live`
- Health/preflight autenticado: `GET /api/radar/health` con `x-api-key`

El preflight `/api/radar/health` requires `x-api-key`; sólo `/api/radar/live` es público y mínimo.

## Desarrollo local

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[test]"
Copy-Item .env.example .env
& ".\scripts\run-dev.ps1"
```

Check operativo con `scripts/check-preflight.ps1`:

```powershell
& ".\scripts\check-preflight.ps1"
```

## Runtime

La entrada STT queda en `audio/audio-16khz.wav` dentro de cada carpeta de job. No borres `runtime/` ni `runtime-logs/` sin una decisión explícita.

## Cloudflare Tunnel

Los ejemplos versionados usan placeholders. Configurá el hostname como `<your-tunnel-hostname>` y el token como `<your-cloudflare-tunnel-token>` fuera del repo.

## Variables importantes

| Variable | Default / ejemplo | Uso |
|---|---|---|
| `TRANSCRIPT_SERVICE_API_KEY` | requerido | Auth de endpoints privados |
| `TRANSCRIPT_SERVICE_PORT` | `8765` | Puerto local |
| `TRANSCRIPT_SERVICE_RUNTIME_DIR` | `runtime` | Carpeta de jobs |
| `TRANSCRIPT_SERVICE_WHISPER_MODEL` | `large-v3` | Modelo Whisper |
| `TRANSCRIPT_SERVICE_WHISPER_MODEL_PATH` | vacío | Ruta local opcional al modelo |
| `TRANSCRIPT_SERVICE_CUDA_DLL_DIRS` | `C:\path\to\torch\lib;C:\path\to\ctranslate2` | Directorios CUDA/cuDNN que `scripts/run-service.ps1` agrega al `PATH` |
| `TRANSCRIPT_SERVICE_FFMPEG_BINARY` | `ffmpeg` | Binario ffmpeg |
| `TRANSCRIPT_SERVICE_YT_DLP_BINARY` | `yt-dlp` | Binario yt-dlp |
| `TRANSCRIPT_SERVICE_YT_DLP_COOKIES_PATH` | `secrets/youtube-cookies.txt` | Archivo Netscape cookies.txt para YouTube. Si existe, se pasa a `yt-dlp` con `--cookies`; si expira, reemplazá este archivo por una exportación nueva sin cambiar código. |
| `TRANSCRIPT_SERVICE_YT_DLP_JS_RUNTIME` | vacío | Runtime JS opcional para `yt-dlp --js-runtimes`, por ejemplo `node`. |

`.env` es local y no se sube al repo.

El archivo de cookies esperado es `secrets/youtube-cookies.txt`. La carpeta `secrets/` está ignorada por git; no versionar ni imprimir su contenido.

## Shared GPU slot and CPU fallback

Whisper is the single ASR implementation for the product: subtitles and the
legacy renderer STT client call `POST /api/radar/transcribe` instead of loading
faster-whisper themselves.

- `NEWSROOM_GPU_LOCK_PATH` (default `/tmp/newsroom-gpu.lock`) is a cross-process
  lock shared with the TTS worker, so only one GPU job runs at a time.
- `TRANSCRIPT_SERVICE_CPU_FALLBACK=1` makes a failed CUDA model load retry with
  `TRANSCRIPT_SERVICE_CPU_FALLBACK_MODEL` (default `small`) on CPU/`int8`.
- The transcribe endpoint accepts `{ "audio_path": "...", "language": "es" }`
  and returns `{ segments, language, device, fallback_used }`; it is protected
  by `x-api-key`.

## Docker

Build from the repository root so the shared worker package is available:

```bash
docker build -f services/asr-worker/Dockerfile -t newsroom-asr .
docker run --rm -p 8765:8765 -e TRANSCRIPT_SERVICE_API_KEY=local-token newsroom-asr
```
