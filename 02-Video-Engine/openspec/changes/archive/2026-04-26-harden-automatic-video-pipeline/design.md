# Design: Harden Automatic Video Pipeline

## Technical Approach

Endurecer el pipeline actual sin reescribirlo: mantener scripts CLI pequeños, agregar normalización previa, contratos Zod compartidos y diagnósticos explícitos. `output/timeline.json` queda como contrato canónico gapless; `render-video.js` solo deriva `output/render-props.json` para Remotion (`Sequence`, `Audio`, `calculateMetadata`) sin UI ni captions.

## Architecture Decisions

| Tema | Opción / tradeoff | Decisión y rationale |
|------|-------------------|----------------------|
| Orquestación | Runner único simplifica control pero aumenta riesgo. | Conservar `npm run pipeline` encadenado y agregar `normalize:audio`; minimiza cambios y respeta comandos individuales. |
| Audio | Fallback directo a audio arbitrario dificulta duración/STT. | `scripts/normalize-audio.js` resuelve `audio/source.*`, luego primer audio compatible si faltan normalizados; genera `audio-16khz.wav` y `audio-48khz.wav` con `ffmpeg-static`, saltea existentes salvo `--force`. |
| Contratos | Validación manual es liviana pero dispersa. | Crear `scripts/lib/schemas.js` con Zod directo en `package.json`; usar helpers `readJsonSchema/writeJsonSchema` para reportar ruta, campo y mensaje. |
| Timeline | `fix-timeline` hoy corrige silenciosamente. | `generate-timeline.js` canonicaliza y escribe timeline; `verify-sync.js` valida/falla gaps/overlaps; `fix:timeline` queda comando explícito/manual de reparación, no oculto en render. |
| Imágenes | Metadata obligatoria rompe flujo. | `imagenes/metadata.json` opcional; scoring mejorado por keywords, aliases y tags; anti-repetición si hay alternativas; placeholder solo con warning fuerte. |

## Data Flow

```text
audio/source.* ─→ normalize-audio ─→ audio-16khz.wav ─→ transcribe-audio.py
                               └──→ audio-48khz.wav ────────────────┐
guion.txt ─→ process-script ─→ align-phrases ─→ generate-timeline ─→ verify-sync
imagenes/* + metadata.json ───────┘                  │              │
                                                     timeline.json ─→ render-video ─→ render-props.json
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `scripts/normalize-audio.js` | Create | FFmpeg-static normalization, source resolution, `--force`, clear exit errors. |
| `scripts/lib/schemas.js` | Create | Zod schemas for script phrases, transcript, phrase timestamps, timeline, render props, report/diagnostics. |
| `scripts/lib/json-contracts.js` | Create | JSON read/write/validate helpers with actionable errors. |
| `scripts/lib/media-utils.js` | Modify | Add source/STT/render audio resolvers; keep render fallback `audio-48khz.wav` then `audio-16khz.wav`. |
| `scripts/process-script.js` | Modify | Validate `|` blocks by original index; empty/whitespace blocks fail; attach image diagnostics. |
| `scripts/lib/phrase-alignment.js` | Modify | Add confidence, thresholds, warnings/errors and fallback taxonomy. |
| `scripts/lib/image-selection.js` | Modify | Metadata-aware scoring and anti-repetition state. |
| `scripts/generate-timeline.js` | Modify | Write canonical validated `timeline.json` and timeline diagnostics. |
| `scripts/verify-sync.js` | Modify | Fail invalid schema/gaps/overlaps and report diagnostics. |
| `scripts/render-video.js` | Modify | Read validated timeline; derive validated render props only. |
| `package.json` | Modify | Add `normalize:audio`, insert before STT in `pipeline`, declare `ffmpeg-static` and `zod`. |
| `requirements.txt` | Modify | Remove `spacy` if still unused. |
| `README.md` | Modify | Document audio inputs, contracts, diagnostics, metadata and Windows-first flow. |

## Interfaces / Contracts

- `timeline.json`: `{ totalDurationSeconds, frames[], diagnostics }`; first frame `0.00`, no gaps/overlaps, last frame equals render-audio duration.
- Frame: `{ id?, phrase, image, startTime, endTime, alignment, imageSelection }`.
- Alignment: `{ source: "word-match"|"segment-fallback"|"tail-fallback", confidence, matchedWords, totalWords, maxDriftMs?, severity: "ok"|"warn"|"error", warnings[] }`. Proposed thresholds: `>=0.75 ok`, `0.5-0.749 warn`, `<0.5 error`; fallback is at least `warn`, tail fallback `error` unless last-segment-only with evidence. Precision target: ±250ms diagnostic warning.
- `imagenes/metadata.json` optional: `{ images: [{ file, aliases?: string[], tags?: string[], weight?: number }] }`; invalid metadata fails only if present.
- `render-props.json`: `{ audioSrc, segments }`, derived from timeline plus copied public media paths.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|--------------|----------|
| Unit | audio source resolver, guion empty blocks, schemas, alignment thresholds, image scoring/repetition | `node --test tests`, temp dirs; mock/spawn boundary for ffmpeg args without render/build. |
| Integration | script chain from processed guion to canonical timeline/report | Existing smoke style with fixture WAVs and generated JSON. |
| CLI smoke | `render-video --dry-run` derives valid props from validated timeline | No builds, installs or real renders. |

## Migration / Rollout

Existing projects with `audio-16khz.wav`/`audio-48khz.wav` continue working and are not overwritten unless `--force`. `audio/source.*` is preferred for new projects. Old timelines without diagnostics should fail with clear regeneration guidance rather than being silently normalized. README updates replace `guion/script.txt` references with `guion/guion.txt`.

## Open Questions

- [ ] Confirm final numeric thresholds after first implementation tests with real transcripts; defaults above are conservative and diagnosable, not UI-visible.
