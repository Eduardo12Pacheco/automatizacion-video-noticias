# Voice TTS Service

Servicio local de generación de voz con **Qwen3-TTS Base**, expuesto al Control Panel mediante una API pública (`tts-orchestrator`) y un worker interno (`tts-worker`) que ejecuta la síntesis en la GPU local.

La prioridad de este proyecto es clara: **preservar la voz personalizada**. La arquitectura ya fue ordenada, pero los wrappers legacy siguen presentes de forma intencional hasta que el runtime real quede validado por escucha humana.

## Estado actual

| Tema | Estado |
| ---- | ------ |
| Arquitectura principal | `voice_tts_service/` |
| Servicios Windows/NSSM | `tts-worker`, `tts-orchestrator`, `tts-tunnel` |
| Health público validado | `https://tts-api.example.local/healthz` respondió OK 200 tras reinstalar servicios |
| Tests determinísticos | `python -m pytest "05-Voice-TTS-Service/tests"` → esperado: `27 passed` |
| Wrappers legacy | Conservados como compatibilidad deprecada, no borrar todavía |

## Arquitectura

```text
05-Voice-TTS-Service/
  voice_tts_service/          # implementación real
    api/                      # FastAPI worker/orchestrator
    application/              # casos de uso, queue, assembly
    cli/                      # CLI canónica de síntesis
    config/                   # settings worker/orchestrator
    domain/                   # presets, estados, segmentación, errores
    infrastructure/           # Qwen/subprocess runner
    storage/                  # SQLite, runtime paths, artifacts
  scripts/                    # instalación/arranque/check de servicios
  tests/                      # contratos determinísticos sin ejecutar modelo real
  config/default.yaml         # defaults sensibles de voz/generación
  refs/                       # referencia de voz/texto
  src/                        # compatibilidad CLI deprecada
  tts-worker/                 # compatibilidad FastAPI worker deprecada
  tts-orchestrator/           # compatibilidad FastAPI pública deprecada
```

## Entrypoints canónicos

Los scripts de servicio usan estos targets del paquete:

```powershell
python -m uvicorn voice_tts_service.api.worker_app:app --host 127.0.0.1 --port 8091
python -m uvicorn voice_tts_service.api.orchestrator_app:app --host 127.0.0.1 --port 8088
```

Para CLI, el código real vive en:

```text
voice_tts_service.cli.synthesize
```

El comando legacy sigue funcionando por compatibilidad:

```powershell
python src/main.py --input input/mi-guion.txt --ref-audio refs/voz.wav --ref-text refs/voz.txt
```

## Qué carpetas NO borrar todavía

| Carpeta | Por qué sigue existiendo | Cuándo se puede borrar |
| ------- | ------------------------ | ---------------------- |
| `src/` | Wrappers/re-exports para comandos CLI legacy. | Solo después de confirmar que nadie usa `python src/main.py` y que la voz real funciona con el entrypoint nuevo. |
| `tts-worker/` | `app.py` delega a `voice_tts_service.api.worker_app`; compatibilidad para comandos viejos. | Solo después de validar NSSM/runtime sin esa ruta. |
| `tts-orchestrator/` | `app.py` delega a `voice_tts_service.api.orchestrator_app`; compatibilidad para comandos viejos. | Solo después de validar NSSM/runtime sin esa ruta. |

Estos wrappers son molestos visualmente, sí, pero hoy son una red de seguridad. Se eliminan con otro SDD cuando el usuario confirme runtime real.

## Qué NO tocar sin autorización explícita

Estos elementos son sensibles para la voz personalizada:

- `config/default.yaml`
- `refs/voz.wav`
- `refs/voz.txt`
- presets (`balanced_default`, `golazo_emotivo`, `golazo_informativo`)
- segmentación
- ensamblado
- sample rate
- nombres/rutas de artifacts
- runtime folders existentes

No corras Qwen/CUDA/SoX/model generation en tests automáticos salvo que se pida un smoke test real.

## Instalar o actualizar servicios Windows

Abrí PowerShell como **Administrador**:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
& "<WORKSPACE>\Desktop\n8n\05-Voice-TTS-Service\scripts\install-services.ps1"
```

Esto actualiza/instala y arranca:

- `tts-worker`
- `tts-orchestrator`
- `tts-tunnel`

## Verificar servicios

```powershell
& "<WORKSPACE>\Desktop\n8n\05-Voice-TTS-Service\scripts\check-services.ps1"
```

Resultado esperado:

```text
tts-worker: RUNNING (StartType=Automatic)
tts-orchestrator: RUNNING (StartType=Automatic)
tts-tunnel: RUNNING (StartType=Automatic)
healthz: OK (200)
TODO OK: ya podés usar 'Creación de audios'.
```

También podés verificar manualmente:

```powershell
Invoke-WebRequest "http://127.0.0.1:8088/healthz" -UseBasicParsing
Invoke-WebRequest "https://tts-api.example.local/healthz" -UseBasicParsing
```

## Verificar código sin ejecutar el modelo real

```powershell
python -m pytest "05-Voice-TTS-Service/tests"
```

Resultado esperado después del cleanup de entrypoints:

```text
27 passed
```

Estos tests cubren contratos de API, worker, runtime, wrappers, entrypoints canónicos y no-drift de defaults sensibles.

## Validación final antes de borrar wrappers

El health prueba que la API vive, pero no prueba la calidad de voz. Antes de eliminar `src/`, `tts-worker/` o `tts-orchestrator/`, hacer esto:

1. Reinstalar/reiniciar servicios con `install-services.ps1`.
2. Confirmar `check-services.ps1` en OK.
3. Generar un audio corto desde el Control Panel.
4. Escuchar el resultado.
5. Confirmar explícitamente que la voz personalizada sigue igual.

Solo después de eso conviene abrir un SDD final para borrar wrappers legacy.

## Flujo de API

```text
01-Control-Panel
  -> https://tts-api.example.local
  -> tts-orchestrator (127.0.0.1:8088)
  -> tts-worker (127.0.0.1:8091)
  -> voice_tts_service.cli.synthesize / Qwen3-TTS
```

Contratos públicos usados por el Control Panel:

- `POST /api/tts/jobs`
- `GET /api/tts/jobs/{job_id}`
- `GET /api/tts/jobs/{job_id}/events`
- `GET /api/tts/jobs/{job_id}/download`
- headers `x-api-key` y Basic Auth
- estados `queued`, `running`, `done`, `error`, `cancelled`

## Salidas de síntesis

- Audio final: `output/<model-tag>/run-YYYYMMDD-HHMMSS.wav`
- Reporte: `output/<model-tag>/run-YYYYMMDD-HHMMSS.report.json`
- Segmentos intermedios: `segments/<model-tag>/run-YYYYMMDD-HHMMSS/*.wav`

El sample rate final queda como lo devuelve Qwen. No se fuerza resampling manual.

## Historial SDD relevante

- `voice-tts-service-refactor` — extracción principal a `voice_tts_service/`.
- `voice-tts-service-warning-cleanup` — cobertura `cancelled` y migración FastAPI lifespan.
- `voice-tts-entrypoint-cleanup` — scripts/docs/tests migrados a entrypoints canónicos sin borrar wrappers.

Los artifacts están en `openspec/changes/archive/` y Engram.
