<p align="center">
  <img src="./Image-Proyect-RemotionEditor.png" alt="Video Engine" />
</p>

# Video Engine

Video Engine es el motor de render final en Remotion. Su trabajo es simple y específico: recibe un contrato ya preparado por `01-Control-Panel`, lo convierte a props de Remotion y genera un MP4 final.

Este proyecto ya no es el editor. No decide imágenes, no calcula el guion, no hace preview de usuario y no es el lugar para mover audio manualmente. Todo eso vive antes, principalmente en `01-Control-Panel` y `03-Contracts-Core`.

## Official render-only flow

```txt
01-Control-Panel
  -> services/approval-editor/lib/video-engine-render-adapter.js
  -> 02-Video-Engine/projects/<id>/composition-contract.json
  -> 02-Video-Engine/scripts/render-video.js --profile=final
  -> 02-Video-Engine/projects/<id>/output/video-final.mp4
```

Comando oficial desde esta carpeta:

```powershell
node scripts/render-video.js --project-root=projects/<id> --profile=final
```

Resultado esperado:

```txt
projects/<id>/output/video-final.mp4
```

## Qué hace este motor

| Responsabilidad | Estado |
|---|---|
| Leer `composition-contract.json` | Sí |
| Adaptar contrato a `render-props.json` | Sí |
| Renderizar `MyComp` con Remotion | Sí |
| Escribir `output/video-final.mp4` | Sí |
| Mantener fidelidad de logo, polvo, outro, motion y timing | Sí |
| Elegir imágenes o videos | No |
| Editar filas/timings desde UI | No |
| Preview del usuario | No |
| Preparar guion/audio como negocio | No |
| Descargar imágenes o buscar assets | No, salvo compatibilidad legacy diferida |

## Archivos importantes

| Ruta | Para qué sirve |
|---|---|
| `scripts/render-video.js` | Wrapper público estable. Control Panel llama este archivo. No lo borres. |
| `scripts/render/render-video.js` | Implementación real del render final. |
| `scripts/lib/contracts/composition-contract.js` | Adapta contrato Approval Editor V1 a props de Remotion. |
| `src/remotion/Root.tsx` | Registro de la composición Remotion. |
| `src/remotion/Composition.tsx` | Render visual final: imágenes/videos, logo, polvo, filtros, outro y audio. |
| `assets/overlays/` | Assets locales necesarios para render final. Pesados y sensibles. |
| `tests/render-only-boundary.test.js` | Protege que no vuelva a crecer como editor/pipeline viejo. |

## Assets necesarios para render final

Antes de renderizar localmente, estos assets deben existir bajo `assets/overlays/`:

```txt
assets/overlays/
├─ particle-1.mp4
├─ particle-2.mp4
├─ overlay-layer-01.mp4
├─ overlay-layer-02.mp4
├─ final-demo-co.mp4
├─ final-demo-ec.mp4
├─ logo-demo-alpha.webm
├─ logo-demo-co.mp4
├─ logo-green.mp4
├─ logo-demo-co-alpha-frames/
└─ logo-ecuador-alpha-frames/
```

No subas assets pesados nuevos a GitHub sin decisión explícita. El repo conserva `.gitkeep` para la carpeta, pero los archivos reales pueden vivir localmente.

## Qué se limpió

Se eliminó el pipeline manual viejo y archivos generados/históricos que no forman parte del render oficial.

Ejemplos de cosas eliminadas:

- wrappers CLI manuales de `setup`, `process`, `generate timeline`, `fix timeline`, `verify sync`;
- modelo Vosk local trackeado;
- audio, imágenes y outputs generados trackeados;
- `output/video-final.mp4` histórico;
- copias duplicadas de skills dentro del subproyecto;
- API/editor local duplicado.

Lo importante: después de borrar eso, el render oficial siguió funcionando y generó MP4 correctamente.

## Deletion boundary for legacy cleanup

| Estado | Rutas |
|---|---|
| Deleted in this work unit | Pipeline manual viejo: `setup`, `process`, `generate timeline`, `fix timeline`, `verify sync`, modelo Vosk trackeado y outputs históricos. |
| Deferred, still present | `scripts/transcribe-audio.py`, wrappers bajo `scripts/lib/`, servicio local legacy y `assets/overlays/`. |

## Qué todavía NO se borra

| Ruta | Por qué se queda |
|---|---|
| `scripts/transcribe-audio.py` | `01-Control-Panel/services/approval-editor/lib/real-alignment.js` todavía puede usarlo para STT/alineación real. |
| wrappers bajo `scripts/lib/` | Compatibilidad temporal mientras callers externos terminan de migrar. |
| `scripts/approval-pipeline-local-service.js` y `scripts/services/approval-pipeline-local-service.js` | Legacy/local service diferido. No es el flujo oficial, pero no se borró en esta tanda. |
| `assets/overlays/` | Render final depende de estos assets para fidelidad visual. |

## Verificación segura

Usá estos checks. No requieren build.

```powershell
pnpm run check:render-boundary
node --test tests/approval-editor-service-v1.test.js tests/composition-contract.test.js tests/editor-contracts.test.js tests/guion-parsing.test.js tests/phrase-alignment.test.js tests/render-only-boundary.test.js
```

Prueba final real, solo cuando quieras generar MP4:

```powershell
node scripts/render-video.js --project-root="projects/<id>" --profile=final
```

## Qué NO hacer

- No correr build como validación normal.
- No revivir el editor local de este proyecto.
- No volver a usar `timeline.json` como contrato principal.
- No meter búsqueda/selección de imágenes acá.
- No borrar `assets/overlays/` sin validar render final.
- No borrar `scripts/transcribe-audio.py` hasta migrar el caller de Control Panel.
- Do not run builds, heavy Remotion renders, model/CUDA/audio generation, or visual exports for this cleanup check.

## Estado actual probado

Se validó el proyecto Luis Díaz con el flujo oficial:

```txt
node scripts/render-video.js --project-root="projects/draft-luis-diaz-..." --profile=final
```

Resultado probado:

- MP4 generado correctamente.
- Duración: `80.490667s`.
- `dust.src`: `overlays/particle-2.mp4`.
- `logo.src`: `overlays/logo-demo-co-alpha-frames`.
- `outro.src`: `overlays/final-demo-co.mp4`.
- Polvos visibles en el render final.

## Scripts útiles

| Script | Uso |
|---|---|
| `pnpm run render:video` | Ejecuta el wrapper de render. Pasá args después con `--`. |
| `pnpm run check:render-boundary` | Verifica que el motor siga siendo render-only. |
| `pnpm test` | Corre tests Node. Para cambios grandes, preferí tests focalizados. |
| `pnpm run dev` | Abre Remotion Studio para inspección local. No es el flujo productivo. |
| `pnpm run lint` | ESLint + TypeScript. No correr si el usuario dijo no build/check pesado. |
| `legacy:approval-service:local` | Legacy/local service. No es el flujo oficial. |
| `legacy:diagnose:stt` | Diagnóstico Python STT. Mantener mientras exista dependencia. |

## Relación con otros subproyectos

| Proyecto | Rol |
|---|---|
| `01-Control-Panel` | Editor oficial, preview, selección de assets y disparador de render. |
| `03-Contracts-Core` | Normalización y helpers compartidos: stable ID, parsing de guion, alignment. |
| `02-Video-Engine` | Render final Remotion. Nada más. |

Si necesitás cambiar cómo se ve el MP4 final, tocá `src/remotion/`. Si necesitás cambiar qué se selecciona, qué fila se edita o qué polvo se elige, eso NO va acá: va en Control Panel o Contracts Core.
