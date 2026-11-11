# Proposal: Harden Automatic Video Pipeline

## Intent

El pipeline automático hoy acepta silenciosamente entradas ambiguas y produce contratos JSON poco validados. Esto vuelve frágil la generación headless: audio no normalizado, bloques vacíos del guion descartados, alineación con fallback poco visible, selección de imágenes repetitiva y `timeline.json`/`render-props.json` sin responsabilidades explícitas.

## Scope

### In Scope
- Normalizar audio Windows-first: generar `audio/audio-16khz.wav` para STT y `audio/audio-48khz.wav` para render con `ffmpeg-static`, respetando archivos existentes salvo `--force`.
- Hacer que `npm run pipeline` ejecute normalización antes de transcripción, manteniendo comando separado.
- Validar guion separado por `|`, fallando ante bloques vacíos.
- Reportar confianza, warnings/fallos y uso fuerte de fallback en alineación, con objetivo ±250ms.
- Mejorar selección automática de imágenes, evitando repetición cuando haya alternativas y usando placeholder con warning fuerte si no hay match aceptable.
- Declarar `output/timeline.json` como contrato canónico y `output/render-props.json` como derivado Remotion.
- Validar JSON generados, actualizar README y remover `spaCy` si sigue sin uso.

### Out of Scope
- UI/editor visual.
- Subtítulos/captions o renderizar texto del guion.
- Soporte Linux/macOS.
- Reescritura completa del pipeline u orquestador único.

## Capabilities

### New Capabilities
- `automatic-video-pipeline`: Contrato headless para audio normalizado, guion por segmentos visuales, alineación diagnosticada, selección de imágenes y timeline canónico.

### Modified Capabilities
- None — no existen specs actuales en `openspec/specs/`.

## Approach

Endurecimiento incremental: conservar scripts y CLI actuales, agregando normalización explícita, validación de contratos y diagnósticos consistentes. Usar Zod si simplifica validar `timeline.json`/`render-props.json` y artefactos intermedios. Mantener Remotion dedicado al render con `Sequence`, `Audio` y metadata determinística; no introducir cambios visuales.

## Alternatives / Tradeoffs

- Orquestador único: más coherencia global, pero mayor riesgo y tamaño para este alcance.
- Validadores manuales sin Zod: menos dependencia directa, pero contratos más frágiles.
- Metadata obligatoria de imágenes: mejor control, pero rompe el flujo actual; queda opcional.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `package.json` | Modified | Comandos de normalización/pipeline y dependencias útiles. |
| `scripts/` | Modified/New | Audio, guion, alineación, selección, timeline, schemas. |
| `tests/` | Modified | Cobertura de fallos, warnings, contratos y repetición. |
| `requirements.txt` | Modified | Remover `spaCy` si no se usa. |
| `README.md` | Modified | Documentar flujo, contratos y diagnósticos. |

## Success Criteria

- [ ] Pipeline genera o respeta audio normalizado según reglas confirmadas.
- [ ] Guion con bloques vacíos falla claramente.
- [ ] Timeline canónico es gapless/non-overlapping, empieza en `0.00` y cubre duración completa.
- [ ] Diagnósticos incluyen estrategia de imagen, confianza, warnings y fallback.
- [ ] JSON inválido falla inmediatamente.

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `ffmpeg-static` aumenta peso npm | Medium | Aceptar costo por Windows-first sin setup manual. |
| Umbrales bloquean casos reales | Medium | Separar warning/failure y exponer evidencia. |
| `fix-timeline` oculta errores | Medium | Definir qué pasos corrigen y cuáles solo validan. |

## Rollout / Operational Notes

Aplicar detrás de comandos existentes, actualizar docs y tests, y permitir rollback revirtiendo cambios en scripts/comandos/dependencias sin tocar composición visual.
