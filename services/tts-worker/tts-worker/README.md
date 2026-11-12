# tts-worker (FastAPI local)

Worker interno para ejecutar jobs de TTS en la GPU local (RTX 4060) usando el pipeline existente `services/tts-worker/src/main.py`.

Entrypoint canónico primario: `voice_tts_service.api.worker_app:app`.

`app.py` se mantiene como compatibilidad deprecada y delega en `voice_tts_service.api.worker_app`; no borrar sin aprobación manual de runtime.

## Alcance MVP (Fase 1)

- Cola serial (`concurrency = 1`)
- Persistencia de estado en SQLite (`runtime/jobs.db`)
- Runtime por defecto preservado en `tts-worker/runtime`.
- Endpoints internos:
  - `POST /internal/jobs`
  - `GET /internal/jobs/{job_id}`
  - `GET /internal/jobs/{job_id}/artifact`

## Instalación

Desde `services/tts-worker/tts-worker`:

```bash
pip install -r requirements.txt
```

## Variables de entorno

Obligatoria:

- `TTS_WORKER_INTERNAL_TOKEN`: token para autenticar llamadas internas.

Opcionales:

- `TTS_WORKER_RUNTIME_DIR` (default: `tts-worker/runtime`)
- `TTS_WORKER_PYTHON` (default: intérprete actual)
- `TTS_WORKER_REF_AUDIO` (default: `../refs/voz.wav`)
- `TTS_WORKER_REF_TEXT` (default: `../refs/voz.txt`)
- `TTS_WORKER_CONFIG` (default: `../config/default.yaml`)
- `TTS_WORKER_QUEUE_MAX` (default: `20`)
- `TTS_WORKER_JOB_TIMEOUT_SEC` (default: `1200`)
- `TTS_WORKER_PRESET` (default: usa YAML)
- `TTS_WORKER_DEVICE` (ej: `cuda:0`)

## Ejecutar

Desde `services/tts-worker/`:

```bash
uvicorn voice_tts_service.api.worker_app:app --host 127.0.0.1 --port 8091
```

Fallback legacy de compatibilidad deprecada, desde `services/tts-worker/tts-worker`:

```bash
uvicorn app:app --host 127.0.0.1 --port 8091
```

## Ejemplo rápido

### Crear job

```bash
curl -X POST "http://127.0.0.1:8091/internal/jobs" \
  -H "Content-Type: application/json" \
  -H "x-internal-token: <TOKEN>" \
  -d "{\"job_id\":\"job_demo_001\",\"text\":\"Este es un texto de prueba suficientemente largo para el mínimo requerido en el MVP.\",\"voice_profile\":\"default\",\"requested_by\":\"local@test\"}"
```

### Consultar estado

```bash
curl -H "x-internal-token: <TOKEN>" "http://127.0.0.1:8091/internal/jobs/job_demo_001"
```

### Descargar audio

```bash
curl -L -H "x-internal-token: <TOKEN>" "http://127.0.0.1:8091/internal/jobs/job_demo_001/artifact" --output job_demo_001.wav
```
