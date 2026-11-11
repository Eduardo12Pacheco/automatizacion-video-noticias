# tts-orchestrator (FastAPI)

API pública para que el frontend cree/consulte/descargue jobs de TTS usando el `tts-worker` interno.

## Alcance MVP (Fase 2)

- Endpoints públicos:
  - `POST /api/tts/jobs`
  - `GET /api/tts/jobs/{job_id}`
  - `GET /api/tts/jobs/{job_id}/download`
- Basic Auth (`Authorization: Basic ...`) + API key en header `x-api-key`
- Rate limit simple por usuario (sliding window)
- Integración con Cloudflare Access mediante header `cf-access-authenticated-user-email`
- Proxy seguro al worker interno con token `x-internal-token`

## Instalación

Desde `voice-lab-qwen/tts-orchestrator`:

```bash
pip install -r requirements.txt
```

## Variables de entorno

Obligatorias:

- `TTS_ORCH_WORKER_INTERNAL_TOKEN`
- `TTS_ORCH_FRONTEND_API_KEY`
- `TTS_ORCH_BASIC_USER`
- `TTS_ORCH_BASIC_PASS`

Opcionales:

- `TTS_ORCH_WORKER_BASE_URL` (default `http://127.0.0.1:8091`)
- `TTS_ORCH_ALLOWED_ORIGINS` (CSV, default `http://localhost:8080`)
- `TTS_ORCH_RATE_LIMIT_PER_MIN` (default `10`)
- `TTS_ORCH_REQUEST_TIMEOUT_SEC` (default `30`)
- `TTS_ORCH_POLL_TIMEOUT_SEC` (default `30`)
- `TTS_ORCH_QUEUE_MAX_HINT` (default `20`)
- `TTS_ORCH_RUNTIME_DIR` (default `tts-orchestrator/runtime`)

## Ejecutar local

```bash
uvicorn app:app --host 127.0.0.1 --port 8088
```

## Flujo

1. Frontend llama `POST /api/tts/jobs` con `x-api-key`.
2. Orchestrator valida y envía job a worker interno.
3. Frontend consulta estado con `GET /api/tts/jobs/{job_id}`.
4. Cuando está `done`, descarga con `GET /api/tts/jobs/{job_id}/download`.
