# MVP API Contract — Remote RTX TTS (Phase 0)

Estado: **Draft v1**  
Objetivo: habilitar generación TTS desde `01-Control-Panel` usando siempre la GPU local RTX 4060.

---

## 1) Arquitectura de servicios

### A. Public Orchestrator (FastAPI)
- Expuesto por Cloudflare Tunnel + Cloudflare Access.
- Responsable de:
  - autenticación/autorización de usuarios
  - validación de payload
  - rate-limit y políticas de uso
  - registrar jobs y consultar estado
  - proxy seguro hacia Worker interno

### B. Local Worker RTX (FastAPI)
- Corre en la PC con RTX 4060.
- Responsable de:
  - cola serial (concurrencia = 1)
  - ejecución de `05-Voice-TTS-Service`
  - persistencia de artefactos (wav/report)
  - exponer estado y descarga al Orchestrator

---

## 2) Estados de Job

Valores permitidos:
- `queued`
- `running`
- `done`
- `error`
- `cancelled`

Transiciones válidas:
- `queued -> running`
- `running -> done | error | cancelled`
- `queued -> cancelled`

---

## 3) Límites operativos MVP

- Concurrencia GPU: `1`
- Cola máxima: `20` jobs
- Tamaño máximo de texto: `6000` caracteres
- Timeout por job: `20 minutos`
- Retención de artefactos: `7 días`

---

## 4) Seguridad MVP (obligatoria)

1. Cloudflare Access (allowlist de 4 usuarios)
2. API key de frontend -> Orchestrator (`x-api-key`)
3. Basic Auth de frontend -> Orchestrator (`Authorization: Basic ...`)
3. Token interno de Orchestrator -> Worker (`x-internal-token`)
5. CORS estricto (solo dominio de Pages)
6. Rate-limit por usuario
7. Worker no expuesto públicamente

---

## 5) Contrato público (Frontend -> Orchestrator)

Base path: `/api/tts`

### 5.1 Crear Job
`POST /api/tts/jobs`

Headers:
- `Content-Type: application/json`
- `x-api-key: <frontend_api_key>`
- `Authorization: Basic <base64(user:pass)>`

Body:
```json
{
  "text": "Texto completo a sintetizar...",
  "title": "opcional-para-nombre",
  "request_id": "opcional-idempotencia",
  "voice_profile": "balanced_default"
}
```

Validaciones:
- `text` requerido
- `text.length` entre `20` y `6000`
- `voice_profile` permitido: `balanced_default | golazo_emotivo | golazo_informativo` (`default` mapea a `balanced_default`)

Respuesta 202:
```json
{
  "job_id": "job_01J...",
  "status": "queued",
  "position": 3,
  "eta_seconds": 900,
  "created_at": "2026-04-13T23:10:00Z"
}
```

Errores:
- `400` payload inválido
- `401/403` no autorizado
- `429` rate limit o cola llena
- `500` error interno

### 5.2 Estado de Job
`GET /api/tts/jobs/{job_id}`

Respuesta 200:
```json
{
  "job_id": "job_01J...",
  "status": "running",
  "progress": {
    "stage": "synthesizing",
    "segments_done": 4,
    "segments_total": 9
  },
  "created_at": "2026-04-13T23:10:00Z",
  "started_at": "2026-04-13T23:10:08Z",
  "finished_at": null,
  "error": null,
  "download_url": null
}
```

Cuando `status = done`, `download_url` debe venir poblado.

### 5.3 Descargar audio
`GET /api/tts/jobs/{job_id}/download`

Respuesta 200:
- `Content-Type: audio/wav`
- `Content-Disposition: attachment; filename="<job_id>.wav"`

Errores:
- `404` job no existe
- `409` job no está `done`
- `410` artefacto expirado

---

## 6) Contrato interno (Orchestrator -> Worker)

Base path: `/internal`

### 6.1 Encolar job en worker
`POST /internal/jobs`

Headers:
- `x-internal-token: <worker_token>`

Body:
```json
{
  "job_id": "job_01J...",
  "text": "Texto...",
  "voice_profile": "default",
  "requested_by": "user@email.com"
}
```

Respuesta 202:
```json
{
  "job_id": "job_01J...",
  "status": "queued"
}
```

### 6.2 Consultar estado interno
`GET /internal/jobs/{job_id}`

Respuesta 200 similar a pública, agregando rutas internas de artefactos.

### 6.3 Descargar artefacto interno
`GET /internal/jobs/{job_id}/artifact`

Devuelve WAV para proxy o stream por Orchestrator.

---

## 7) Modelo de datos mínimo (SQLite)

Tabla `jobs`:
- `job_id` TEXT PK
- `status` TEXT NOT NULL
- `text_sha256` TEXT NOT NULL
- `text_length` INTEGER NOT NULL
- `requested_by` TEXT
- `created_at` DATETIME NOT NULL
- `started_at` DATETIME
- `finished_at` DATETIME
- `error_code` TEXT
- `error_message` TEXT
- `output_wav_path` TEXT
- `output_report_path` TEXT

Índices:
- `idx_jobs_status_created_at (status, created_at)`
- `idx_jobs_requested_by_created_at (requested_by, created_at)`

---

## 8) Mapeo de errores estándar

- `INVALID_TEXT` -> `400`
- `UNAUTHORIZED` -> `401`
- `FORBIDDEN` -> `403`
- `QUEUE_FULL` -> `429`
- `RATE_LIMITED` -> `429`
- `JOB_NOT_FOUND` -> `404`
- `JOB_NOT_READY` -> `409`
- `ARTIFACT_EXPIRED` -> `410`
- `WORKER_TIMEOUT` -> `504`
- `INTERNAL_ERROR` -> `500`

Formato:
```json
{
  "error": {
    "code": "QUEUE_FULL",
    "message": "La cola está llena. Intentá más tarde.",
    "details": null
  }
}
```

---

## 9) Criterios de aceptación de Fase 0

1. Contrato público e interno definido y versionado.
2. Estados/transiciones cerrados.
3. Límites y seguridad mínima documentados.
4. Errores normalizados con códigos consistentes.

Cuando esto se aprueba, arranca **Fase 1 (Worker RTX)**.
