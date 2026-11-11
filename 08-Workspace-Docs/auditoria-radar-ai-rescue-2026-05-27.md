# Auditoría Completa: Radar (Investigación) + AI Rescue

**Fecha**: 27 de mayo de 2026  
**Alcance**: 3 repositorios auditados en profundidad, sin modificaciones de código  
**Método**: 3 subagentes `sdd-explore` en paralelo + verificación en vivo del navegador

---

## Repositorios auditados

| Repo | Ruta | Rol |
|------|------|-----|
| 10-Channel-Monitor-Service | `<WORKSPACE>\Desktop\n8n\10-Channel-Monitor-Service` | Monitoreo de canales YouTube, filtrado, AI Rescue |
| 09-Transcript-Service | `<WORKSPACE>\Desktop\n8n\09-Transcript-Service` | Transcripción (Whisper) y análisis de menciones |
| 01-Control-Panel | `<WORKSPACE>\Desktop\n8n\01-Control-Panel\js\modules\features\radar\` + `ai-rescue\` | Frontend de Investigación y AI Rescue |

---

## Arquitectura general del pipeline

```
YouTube API ──► Channel Monitor (:8775) ──► Transcript Service (:8765)
                     │                              │
                     │ filtra candidatos            │ descarga audio
                     │ evalúa títulos               │ transcribe (Whisper)
                     │ clasifica matches            │ busca keywords
                     │                              │
                     ▼                              ▼
               Radar Monitor ◄────────────── Resultados (menciones, resumen)
                     │
                     ▼
               AI Rescue ──► LLM (DeepSeek) re-evalúa rechazados
                     │
                     ▼
               Aprueba/Rechaza ──► Reingresa a Radar como "RESCATADO IA"
```

---

# 1. 10-Channel-Monitor-Service (`:8775`)

## 1.1 Estado general

- **Stack**: Python 3.11 + FastAPI + Uvicorn + SQLite
- **Endpoints**: 21 (incluyendo AI Rescue, WebSub, health, CRUD canales)
- **Workers**: 7 background workers (Discovery, Catchup, Enqueue, TranscriptSync, AiRescue, Cleanup, WebSubRenewal)
- **Tests**: 145 tests, 1 fallando
- **Puerto**: 127.0.0.1:8775

## 1.2 🔴 Crítico: Secretos en `.env` sin `.gitignore`

**Archivo**: `10-Channel-Monitor-Service\.env`

Contiene **5 claves en texto plano**:
- `CHANNEL_MONITOR_API_KEY`
- `CHANNEL_MONITOR_RADAR_API_KEY` (mismo valor que API_KEY — posible copy-paste)
- `CHANNEL_MONITOR_CALLBACK_SECRET` (WebSub HMAC)
- `CHANNEL_MONITOR_YOUTUBE_API_KEY` (Google Cloud API key)
- `CHANNEL_MONITOR_AI_RESCUE_OPENCODE_API_KEY` (LLM API key)

**Riesgo**: No existe `.gitignore` a nivel proyecto. Si este repo se commitea a git, todas las claves quedan expuestas.

**Plan de resolución**:
1. Agregar `.gitignore` con `.env` inmediatamente
2. Migrar secretos a variables de entorno del sistema o Windows Credential Manager
3. Rotar todas las claves expuestas si alguna vez estuvieron en un repo remoto

## 1.3 🔴 Crítico: Archivos fuente `.py` borrados

**Archivos**: `app/` y `tests/` solo contienen `__pycache__/` con `.pyc`. No hay `.py` en ningún lado.

**Riesgo**: Si se limpia `__pycache__`, se actualiza Python, o se mueve el proyecto, el servicio es **irrecuperable** sin decompilación.

**Plan de resolución**:
1. Recuperar fuentes desde git (si existe historial) o backup
2. Si no hay backup, decompilar `.pyc` con `uncompyle6` o `pycdc`
3. Versionar los `.py` recuperados inmediatamente

## 1.4 🟡 Alto: 1 test fallando

**Test**: `test_discovery_worker_evaluates_completed_vod_once_and_marks_matching_candidate`

**Ubicación**: `tests/` (registrado en `.pytest_cache/lastfailed`)

**Posible causa**: Regresión en la lógica de evaluación del Discovery Worker.

**Plan de resolución**:
1. Recuperar fuentes `.py` primero
2. Ejecutar el test individualmente con `-v` para ver el traceback
3. Revisar cambios recientes en `workers.py` → `process_video_id`

## 1.5 🟡 Alto: Errores DNS crashean batches enteros

**Ubicación**: `workers.py` — `poll_pending_live()` y `catchup()`

**Problema**: Usan list comprehension que no captura errores por ítem:
```python
[self.process_video_id(v.video_id) for v in self.store.list_pending_live()]
```
Un solo video con error DNS (`getaddrinfo failed`) crashea todo el batch. Los logs están llenos de estos errores.

**Plan de resolución**:
1. Envolver cada `process_video_id` en try/except individual
2. Agregar circuit breaker: si N videos consecutivos fallan por DNS, pausar el worker
3. Implementar exponential backoff en reintentos

## 1.6 🟡 Medio: `/api/monitor/summary` 404 intermitente

**Ubicación**: `main.py` — endpoint `/api/monitor/summary`

**Evidencia**: Logs muestran 404 en accesos tempranos, luego 200. Posible race condition en registro de rutas o conflicto con trailing slash.

**Plan de resolución**:
1. Verificar que la ruta esté registrada antes de que el worker empiece
2. Agregar redirect de trailing slash explícito
3. Agregar test de integración para el endpoint

## 1.7 🟡 Medio: SQLite como única BD

**Problema**: 7 workers concurrentes + API reads compiten por un solo archivo SQLite. Bajo carga, `SQLITE_BUSY`.

**Plan de resolución**:
1. Habilitar WAL mode (`PRAGMA journal_mode=WAL`)
2. Aumentar timeout de busy (`PRAGMA busy_timeout=5000`)
3. A largo plazo: migrar a PostgreSQL para producción

## 1.8 🟢 Bajo: Otras observaciones

| Item | Ubicación | Plan |
|------|-----------|------|
| Sin rate limiting en API | `main.py` | Agregar slowapi o middleware manual |
| Sin métricas/monitoreo | Todo el servicio | Agregar structured logging + health endpoint completo |
| Config no es hot-reloadable | `channel_bootstrap.py` | Agregar file watcher para `channels.yaml` |
| WebSub deshabilitado (`WORKER_WEBSUB_ENABLED=false`) | `.env` | Evaluar activarlo para notificaciones push |
| `opencode_go_client.py` SSRF: validación frágil de host | `opencode_go_client.py` | Usar `urlparse` + whitelist estricto |
| API_KEY = RADAR_API_KEY (mismo valor) | `.env` | Verificar si es intencional o copy-paste |
| Modelo AI Rescue: `deepseek-v4-flash` | `.env` | Verificar nombre correcto contra OpenCode backend |

---

# 2. 09-Transcript-Service (`:8765`)

## 2.1 Estado general

- **Stack**: Python 3.11.4 + FastAPI + Uvicorn
- **Modelo**: faster-whisper `large-v3-turbo` en CUDA (GPU)
- **Endpoints**: 12 (jobs CRUD, transcript, mentions, summary, export, catalog)
- **Ubicación modelo**: `<WORKSPACE>\Desktop\n8n\local\models\faster-whisper-large-v3-turbo`
- **Puerto**: 127.0.0.1:8765

## 2.2 🔴 Alto: API key en `.env` texto plano

**Archivo**: `09-Transcript-Service\.env`

`TRANSCRIPT_SERVICE_API_KEY` en texto plano. Mismo riesgo que Channel Monitor.

**Plan de resolución**: Igual que 1.2 — migrar a variables de entorno del sistema.

## 2.3 🔴 Alto: Sin limpieza de archivos — riesgo de llenar disco

**Archivos**: `runtime/jobs/{uuid}/source.webm` + `audio/audio-16khz.wav`

**Problema**: Cada job descarga el video completo (~50-200MB). Los archivos **nunca se borran** automáticamente. Solo se limpian si se llama explícitamente a `DELETE /api/radar/jobs/{id}`.

**Plan de resolución**:
1. Agregar worker de limpieza con TTL (ej: borrar source.webm después de 24h, guardar solo transcripción)
2. Agregar flag `--max-filesize` a yt-dlp para limitar descargas
3. Agregar endpoint `POST /api/radar/cleanup` para limpieza manual
4. Monitorear uso de disco con alerta

## 2.4 🟡 Medio: `preflight.py` tiene import roto

**Archivo**: `app/preflight.py` (línea 14-19, 31)

```python
import importlib.util  # alias `importlib` en el fuente
# ...
has_faster_whisper = importlib.util.find_spec('faster_whisper')  # ERROR
```

Después del alias, `importlib` ES `importlib.util`. `importlib.util.find_spec` → `importlib.util.util.find_spec` → **AttributeError**.

**Impacto**: El health check de faster-whisper falla silenciosamente. No afecta la transcripción en sí, pero `/api/radar/health` reporta incorrectamente que el modelo no está disponible.

**Plan de resolución**:
1. Cambiar el import a `import importlib` (sin `.util`)
2. Usar `importlib.util.find_spec` con el nombre completo
3. Agregar test para el health endpoint

## 2.5 🟡 Medio: `mention_count = 0` en casi todos los jobs

**Archivos**: `catalog.py`, `mention_engine.py`

**Evidencia**: 18 jobs en `runtime/jobs/index.json`. Solo 1 tiene `mention_count > 0`. Los demás tienen 0.

**Posibles causas**:
1. `detected_language` es `null` en todos los jobs → el catálogo multilingüe (7 idiomas) no se usa, solo variantes `base`
2. Normalización Unicode (NFKD) puede ser demasiado agresiva con ciertos caracteres
3. Word boundaries (`(?<!\w)`) pueden no coincidir con pronunciaciones en audio transcrito
4. Variantes del catálogo (ej: "Pacho"/"Pachio") pueden no cubrir todas las formas en que Whisper transcribe nombres

**Plan de resolución**:
1. Investigar por qué `detected_language` es null — ¿bug en `normalize_language()`? ¿Whisper no detecta idioma?
2. Agregar logging de qué keywords se buscaron y en qué segmentos
3. Probar con un video de prueba conocido (que se sepa que menciona "Ecuador")
4. Considerar fuzzy matching (Levenshtein) para variantes de nombres
5. Agregar un endpoint de debug: `POST /api/radar/debug/match` que muestre qué matchea y qué no

## 2.6 🟡 Medio: Un solo job a la vez (mutex lock)

**Archivo**: `app/worker.py`

**Problema**: `TranscriptWorker` usa `threading.Lock` + flag `busy`. Solo 1 job puede correr. Si otro llega, devuelve 409 Conflict. Sin cola real.

**Plan de resolución**:
1. Implementar `queue.Queue` con consumer thread continuo
2. Agregar endpoint `GET /api/radar/queue` para ver posición en cola
3. Permitir N workers concurrentes si hay suficiente VRAM

## 2.7 🟡 Medio: Archivos `.py` borrados

Mismo problema que Channel Monitor (1.3). Solo `__pycache__/` en `app/` y `tests/`.

## 2.8 🟢 Bajo: Otras observaciones

| Item | Ubicación | Plan |
|------|-----------|------|
| Catálogo duplicado: `TARGET_PROFILES` vs `COUNTRY_CATALOG` | `mention_engine.py` + `catalog.py` | Unificar en un solo catálogo |
| `stage` nunca se actualiza (siempre "queued") | `worker.py` | Agregar transiciones: downloading→extracting→transcribing→analyzing |
| `progress` (0-100) nunca se actualiza | `models.py` | Reportar progreso real |
| Sin rate limiting | `main.py` | Agregar slowapi |
| `queue.py` referenciado pero no existe | `settings.py` → `app.queue` | Verificar si es import muerto o archivo faltante |
| `_run` duplicado en `audio.py` y `downloader.py` | Ambos | Extraer a utilidad compartida |
| Sin structured logging | Todo | Agregar `logging` module con niveles |
| `subprocess_timeout_seconds = 1800` (30 min) | `settings.py` | Un video stuck bloquea el worker 30 min |

---

# 3. 01-Control-Panel — Radar + AI Rescue

## 3.1 Estado general

- **Módulos Radar**: `state.js`, `api-client.js`, `controller.js`, `render.js` (4 archivos)
- **Módulos AI Rescue**: `state.js`, `api-client.js`, `controller.js`, `render.js`, `index.js` (5 archivos)
- **Checks**: Radar 608 líneas, AI Rescue 413 líneas
- **Lazy loading**: Ambos features cargan bajo demanda (no en boot)

## 3.2 🟡 Medio: AI Rescue sin remote context guard

**Archivo**: `js/modules/features/ai-rescue/controller.js`, función `activate()` (línea 15-19)

**Problema**: Radar tiene `api.isBlockedByRemoteContext()` que bloquea llamadas a localhost desde Cloudflare Pages. AI Rescue **no tiene este guard**. Si se accede desde la web con `channelMonitorBaseUrl: 'http://127.0.0.1:8775'`, las llamadas fallan silenciosamente.

**Plan de resolución**:
1. Agregar `isBlockedByRemoteContext()` al `activate()` de AI Rescue
2. Mostrar mensaje accionable: "AI Rescue requiere acceso local. Abrí el panel desde la máquina local."
3. Agregar test para verificar el guard

## 3.3 🟡 Medio: Race condition en guard de polling

**Archivos**: `radar/controller.js:150-152`, `ai-rescue/controller.js`

**Problema**: El guard `pollingInFlight` tiene una ventana entre el check y el set:
```javascript
if (state.pollingInFlight) return;
state.pollingInFlight = true;  // no atómico
```
Dos llamadas rápidas pueden pasar el check antes de que la primera ponga el flag.

**Plan de resolución**:
1. Usar un contador en vez de booleano: `pollingInFlight++` / `pollingInFlight--`
2. O usar `Promise` tracking: guardar la promise del poll actual y hacer `await`

## 3.4 🟢 Bajo: Código muerto

| Item | Ubicación | Líneas |
|------|-----------|--------|
| `enrichMonitorCards()` — nunca llamada | `radar/controller.js:103-113` | 11 |
| `summaryByJobId` — nunca leído ni escrito | `radar/state.js` | 1 campo |
| `legacySetView` — duplica `navigation.js:setView` | `runtime.js:556-617` | 62 |

**Plan de resolución**:
1. Eliminar `enrichMonitorCards` y `summaryByJobId`
2. Migrar `legacySetView` a usar `navigation.setView` directamente o eliminar si no se usa

## 3.5 🟢 Bajo: Duplicación de código

| Función | Duplicada en | Veces |
|---------|-------------|-------|
| `escapeHtml()` | `radar/render.js`, `ai-rescue/render.js`, `ai-rescue/controller.js` | 3 |
| `isSafeYouTubeUrl()` | `radar/controller.js`, `ai-rescue/controller.js` (versiones ligeramente distintas) | 2 |
| `formatTimestamp()` | `radar/render.js`, `ai-rescue/render.js` | 2 |
| `COUNTRY_LABELS` | `radar/state.js`, `ai-rescue/render.js` | 2 |

**Plan de resolución**: Extraer a `js/modules/shared/` como utilidades compartidas.

## 3.6 🟢 Bajo: Funcionalidad faltante

| Feature | Prioridad | Plan |
|---------|-----------|------|
| Sin retry automático en API calls fallidas | Media | Agregar retry con backoff (máx 3 intentos) |
| Sin auto-refresh en vista Radar Monitor | Media | Agregar polling cada 60s como en AI Rescue |
| Sin paginación en historial de jobs | Baja | Agregar "Cargar más" con offset/limit |
| Sin batch approve/reject en AI Rescue | Baja | Agregar checkboxes + botón "Aprobar seleccionados" |
| Sin búsqueda/filtro en candidatos | Baja | Agregar input de búsqueda textual |
| Sin ordenamiento por score en AI Rescue | Baja | Agregar toggle asc/desc en columna score |
| Sin indicador de "nuevo" vs "ya visto" | Baja | Agregar flag `seen` + indicador visual |
| Sin undo para approve/reject | Baja | Agregar toast con "Deshacer" por 5 segundos |

## 3.7 🟢 Bajo: Accesibilidad

| Gap | Ubicación | Plan |
|-----|-----------|------|
| Sin `role="list"` / `role="listitem"` en cards | `render.js` | Agregar roles ARIA |
| Sin focus management en dialogs | `controller.js` | Mover foco al dialog al abrir |
| Sin `aria-live` en actualizaciones de polling | `render.js` | Agregar región live para nuevos datos |
| Sin `aria-busy` durante carga | `render.js` | Agregar indicador de carga |
| innerHTML destruye foco en updates | `render.js` | Usar DOM diffing o preservar foco |

---

# 4. Resumen de severidad

## 🔴 Crítico (3 items)

| # | Hallazgo | Repo |
|---|----------|------|
| 1 | `.env` con 5 secretos en texto plano + sin `.gitignore` | Channel Monitor |
| 2 | `.env` con API key en texto plano | Transcript Service |
| 3 | Archivos `.py` fuente borrados (solo `.pyc`) | Ambos servicios |

## 🟡 Alto/Medio (10 items)

| # | Hallazgo | Repo |
|---|----------|------|
| 4 | 1 test fallando (discovery worker) | Channel Monitor |
| 5 | Errores DNS crashean batches de workers | Channel Monitor |
| 6 | Sin limpieza de archivos (riesgo de llenar disco) | Transcript Service |
| 7 | `mention_count = 0` en casi todos los jobs | Transcript Service |
| 8 | `detected_language = null` en todos los jobs | Transcript Service |
| 9 | `preflight.py` import roto (health check falso) | Transcript Service |
| 10 | AI Rescue sin remote context guard | Control Panel |
| 11 | Race condition en polling guard | Control Panel |
| 12 | Single-threaded worker (1 job a la vez) | Transcript Service |
| 13 | SQLite cuello de botella con 7 workers | Channel Monitor |

## 🟢 Bajo (15+ items)

Código muerto, duplicación, sin retry, sin paginación, accesibilidad, etc.
Ver secciones 1.8, 2.8, 3.4-3.7 arriba.

---

# 5. Orden de prioridad recomendado

1. **Agregar `.gitignore`** a ambos servicios → protege contra leaks inmediatos
2. **Migrar secretos** de `.env` a variables de entorno del sistema
3. **Recuperar archivos `.py`** → sin fuentes no se puede mantener nada
4. **Investigar `mention_count = 0`** → el core del pipeline no está funcionando
5. **Agregar limpieza de archivos** en Transcript Service → prevenir crash por disco lleno
6. **Fixear test roto** en Channel Monitor
7. **Agregar manejo de errores por ítem** en workers (DNS cascada)
8. **Fixear AI Rescue remote context guard**
9. **Fixear race condition en polling**
10. **Limpiar código muerto y duplicación**
11. **Mejoras de features** (retry, paginación, batch ops)

---

*Reporte generado por 3 subagentes sdd-explore en paralelo. No se modificó ningún archivo.*
