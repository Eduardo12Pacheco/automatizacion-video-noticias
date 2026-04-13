# Runbook — Servicios Windows con NSSM (TTS Stack)

Guía operativa completa para correr `tts-worker`, `tts-orchestrator` y `tts-tunnel` como servicios Windows automáticos.

---

## 1) ¿Qué problema resuelve este setup?

Antes, el stack necesitaba 3 terminales manuales:

- worker (puerto local `8091`)
- orchestrator (puerto local `8088`)
- cloudflared tunnel (publicación externa)

Con NSSM:

- los 3 corren como **servicios Windows**,
- arrancan en boot (`StartType=Automatic`),
- reinician ante fallos,
- escriben logs persistentes.

> Importante: si la PC está apagada, la API de audio no funciona (la inferencia depende de la RTX local).

---

## 2) Arquitectura actual (en producción local)

```text
approval-panel-web (Cloudflare Pages)
        |
        v
https://tts-api.example.local  (Cloudflare Tunnel)
        |
        v
tts-orchestrator (FastAPI, 127.0.0.1:8088)
        |
        v
tts-worker (FastAPI, 127.0.0.1:8091)
        |
        v
src/main.py + Qwen3-TTS (RTX local)
```

---

## 3) Prerrequisitos

1. PowerShell ejecutado como **Administrador**.
2. NSSM instalado (ejemplo):

```powershell
winget install NSSM.NSSM
```

3. Cloudflared instalado y túnel creado.
4. Archivos existentes:

- `<WORKSPACE>/.cloudflared/cert.pem`
- `<WORKSPACE>/.cloudflared/1bf44f10-4a6a-4039-a63c-14c8e92b2638.json`
- `<WORKSPACE>/.cloudflared/config.yml`

5. Variables locales en `.env.local` (token interno, api key, basic auth, python del venv CUDA, etc.).

---

## 4) Scripts clave

- `scripts/install-services.ps1`  
  Instala/actualiza servicios con NSSM, recovery policy, logs y auto-start.

- `scripts/run-worker.ps1`  
  Levanta worker con `.venv-qwen` en `127.0.0.1:8091`.

- `scripts/run-orchestrator.ps1`  
  Levanta orchestrator en `127.0.0.1:8088`.

- `scripts/run-tunnel.ps1`  
  Levanta cloudflared con `--config`, `--origincert`, `--credentials-file` explícitos.

- `scripts/check-services.ps1`  
  Verifica estado de servicios + health público.

---

## 5) Instalación / actualización de servicios

En PowerShell Admin:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
& "<WORKSPACE>\Desktop\n8n\voice-lab-qwen\scripts\install-services.ps1"
```

Servicios creados:

- `tts-worker`
- `tts-orchestrator` (depende de `tts-worker`)
- `tts-tunnel` (depende de `tts-orchestrator`)

---

## 6) Comandos operativos útiles

### Estado

```powershell
Get-Service tts-worker,tts-orchestrator,tts-tunnel | Select Name,Status,StartType
```

### Reinicio ordenado

```powershell
Restart-Service tts-worker
Start-Sleep -Seconds 2
Restart-Service tts-orchestrator
Start-Sleep -Seconds 2
Restart-Service tts-tunnel
```

### Start/Stop completo

```powershell
Stop-Service tts-tunnel,tts-orchestrator,tts-worker -Force
Start-Service tts-worker
Start-Sleep -Seconds 2
Start-Service tts-orchestrator
Start-Sleep -Seconds 2
Start-Service tts-tunnel
```

### Health local y público

```powershell
Invoke-WebRequest "http://127.0.0.1:8088/healthz" -UseBasicParsing
Invoke-WebRequest "https://tts-api.example.local/healthz" -UseBasicParsing
```

### Check rápido (script nuevo)

```powershell
& "<WORKSPACE>\Desktop\n8n\voice-lab-qwen\scripts\check-services.ps1"
```

---

## 7) Logs y dónde mirar

### Logs runtime del stack

- `runtime-logs/orchestrator.out.log`
- `runtime-logs/orchestrator.err.log`
- `runtime-logs/worker.out.log`
- `runtime-logs/worker.err.log`
- `runtime-logs/tunnel.out.log`
- `runtime-logs/tunnel.err.log`

### Logs específicos de servicios NSSM

- `runtime-logs/services/tts-worker.out.log`
- `runtime-logs/services/tts-worker.err.log`
- `runtime-logs/services/tts-orchestrator.out.log`
- `runtime-logs/services/tts-orchestrator.err.log`
- `runtime-logs/services/tts-tunnel.out.log`
- `runtime-logs/services/tts-tunnel.err.log`

---

## 8) Problemas reales que aparecieron y fix aplicado

### A) NSSM quote error (`-File '\\'`)

**Síntoma:** el servicio no arrancaba y PowerShell decía que `-File '\\'` no era `.ps1` válido.  
**Causa:** escape de comillas al instalar servicio con argumentos inline.  
**Fix:** separar `nssm install` (solo exe) y luego `nssm set AppParameters ...`.

### B) `Errno 10048` en puertos 8088/8091

**Síntoma:** worker/orchestrator no podían bindear puertos.  
**Causa:** procesos manuales previos ocupaban puertos.  
**Fix:** cerrar procesos manuales y reiniciar servicios.

### C) `tts-tunnel` en `Paused` / 503 público

**Síntoma:** servicio running/paused, pero endpoint público devolvía 503.  
**Causas detectadas:**

1. faltaba `origincert` en contexto LocalSystem,
2. cloudflared no cargaba `config.yml` por path implícito.

**Fix:** en `run-tunnel.ps1` pasar explícitamente:

- `--config <WORKSPACE>/.cloudflared/config.yml`
- `--origincert <WORKSPACE>/.cloudflared/cert.pem`
- `--credentials-file <WORKSPACE>/.cloudflared/<tunnel-id>.json`

---

## 9) Arranque automático al prender la PC

Con `StartType=Automatic`, Windows intenta iniciar servicios en boot.

Flujo esperado tras encender:

1. esperar ~1-2 minutos,
2. correr `check-services.ps1`,
3. si todo está `Running` y `/healthz` público responde `ok=true`, ya podés usar “Creación de audios”.

---

## 10) Límites operativos importantes

- Si la PC está apagada, suspendida o sin red, no hay inferencia/audio.
- Cloudflare Tunnel puede reconectar solo ante microcortes, pero no reemplaza uptime de servidor dedicado.
- La carga TTS depende de recursos locales (RTX + CPU + red).

---

## 11) Comando de diagnóstico mínimo (copy/paste)

```powershell
Get-Service tts-worker,tts-orchestrator,tts-tunnel | Select Name,Status,StartType; \
try { (Invoke-WebRequest "https://tts-api.example.local/healthz" -UseBasicParsing -TimeoutSec 10).Content } \
catch { "HEALTHZ ERROR: $($_.Exception.Message)" }
```

---

## 12) Próximo hardening recomendado

1. watchdog programado (Task Scheduler) para reiniciar `tts-tunnel` si `/healthz` falla N veces.
2. bajar carga de polling frontend/backend (backoff dinámico, update sólo ante cambios).
3. opcional: migrar GPU a host dedicado si se busca alta disponibilidad real.
