## Exploration: harden-automatic-video-pipeline

### Current State
El proyecto es un pipeline CLI/headless: `npm run pipeline` ejecuta `setup-project -> process-script -> transcribe-audio -> align-phrases -> generate-timeline -> fix-timeline -> verify-sync`, y `npm run render:video` deriva `output/render-props.json` desde `output/timeline.json` antes de invocar Remotion.

- Audio: `scripts/transcribe-audio.py` consume por defecto `audio/audio-16khz.wav`; `scripts/lib/media-utils.js` resuelve audio de render con orden `audio-48khz.wav -> audio-16khz.wav -> primer audio compatible`. No existe normalización FFmpeg ni comando separado; `parseWavDurationSeconds()` solo lee WAV.
- Guion: `scripts/process-script.js` lee `guion/guion.txt`, separa por `|`, hace `trim()` y luego `.filter(Boolean)`, por lo que bloques vacíos se descartan silenciosamente. Esto contradice la decisión de fallar claro ante bloques vacíos.
- Alineación: `scripts/lib/phrase-alignment.js` intenta match secuencial de palabras con ratio mínimo `1.0` para frases de <=2 tokens y `0.6` para más largas; si no matchea, cae a `segment-fallback` y luego `timeline-tail-fallback`. La salida registra `source`, `matchedWords`, `totalWords`, pero no `confidence`, severidad ni umbrales.
- Timeline: `generate-timeline.js` crea `timeline.json` con `{ totalDurationSeconds, frames }`; `fix-timeline.js`, `verify-sync.js` y `render-video.js` vuelven a normalizar frames. `timeline.json` funciona de facto como fuente para render, pero `render-props.json` contiene segmentos normalizados y rutas públicas derivadas, lo que conviene explicitar como contrato derivado.
- Imágenes: `scripts/lib/image-selection.js` extrae keywords simples, ordena imágenes alfabéticamente, puntúa por cantidad de keywords incluidas en el nombre y elige el primer candidato con score > 0. Si no hay match usa primera imagen alfabética; si no hay imágenes usa placeholder. No evita repeticiones, no desempata por mejor score real después de ordenar, no usa metadata ni aliases.
- Contratos JSON: los scripts hacen `JSON.parse` directo y escriben JSON sin validación central. No hay schemas propios; `zod` aparece en `package-lock.json` como transitivo de Remotion, pero no está declarado directo en `package.json`.
- Tests: hay unit tests para imagen, alineación y timeline, más smoke test CLI con `render-video --dry-run`. Hay buena base para endurecer reglas sin renderizar ni compilar.
- Dependencias/docs: `requirements.txt` incluye `spacy==3.8.13`, pero no hay uso en `scripts/`; solo aparece en documentación histórica (`Tasks_Proyecto_Automatic_Generation_with_checkboxes.md`). README ya documenta `guion/guion.txt` arriba, pero su árbol aún dice `guion/script.txt`; tampoco documenta normalización FFmpeg ni diagnósticos fuertes de alineación.

### Affected Areas
- `package.json` — agregar futuro `normalize:audio`, insertar el paso antes de `transcribe-audio` en `pipeline`, declarar `ffmpeg-static`/`zod` si se usan y eventualmente remover dependencias indirectas no deseadas.
- `requirements.txt` — remover `spacy` si se confirma que seguirá sin uso productivo.
- `scripts/lib/media-utils.js` — centralizar resolución de audio fuente/render/STT y duración; revisar soporte de duración para audio fuente no WAV si se permite fallback directo.
- `scripts/normalize-audio.js` (nuevo futuro) — punto natural para generar `audio-16khz.wav` y `audio-48khz.wav` con `ffmpeg-static`, respetando existentes salvo `--force`.
- `scripts/process-script.js` — preservar índices de bloques y fallar con mensaje claro ante `||`, separador inicial/final o bloques whitespace-only.
- `scripts/lib/image-selection.js` — mejorar scoring, desempates, anti-repetición, metadata opcional y placeholder con warning fuerte.
- `scripts/lib/phrase-alignment.js` — introducir `confidence`, thresholds y diagnósticos; no ocultar fallback en un simple `source`.
- `scripts/generate-timeline.js`, `scripts/fix-timeline.js`, `scripts/verify-sync.js`, `scripts/render-video.js` — consolidar contrato: `timeline.json` canonical, `render-props.json` derivado; fallar gaps/overlaps; propagar diagnósticos.
- `scripts/lib/contracts.js` o `scripts/lib/schemas.js` (nuevo futuro) — mejor ubicación para schemas Zod compartidos por scripts CLI.
- `src/Root.tsx`, `src/Composition.tsx` — están alineados con `Sequence`, `Audio` y `calculateMetadata`; no requieren cambio visual/captions para este alcance.
- `tests/*.test.js` — ampliar cobertura de normalización, guion vacío, schemas, thresholds, metadata/anti-repetición, timeline canónico y fallos por gaps/overlaps.
- `README.md` — actualizar flujo, convención de audio normalizado/source, metadata opcional, diagnósticos y contratos.

### Approaches
1. **Endurecimiento incremental del pipeline actual** — mantener scripts Node/Python actuales y agregar normalización, schemas y diagnósticos en módulos pequeños.
   - Pros: menor riesgo, conserva CLI/headless, encaja con tests existentes, no toca UI ni composición visual.
   - Cons: mantiene varios pasos y JSON intermedios; requiere disciplina para no duplicar normalización en demasiados scripts.
   - Effort: Medium

2. **Orquestador único con contrato central** — crear un runner que controle todo el pipeline, valide cada artefacto y genere diagnósticos globales.
   - Pros: fuente de verdad más clara, mejor control de errores, menos drift entre pasos.
   - Cons: cambio más grande, más riesgo de romper comandos individuales ya testeados; innecesario para el alcance confirmado.
   - Effort: High

3. **Validación mínima sin Zod** — seguir con validadores manuales en utilidades existentes.
   - Pros: menos dependencia directa y menor cambio inicial.
   - Cons: contratos más frágiles, peor mantenibilidad, difícil expresar diagnósticos consistentes.
   - Effort: Low/Medium

### Recommendation
Recomiendo el enfoque 1: endurecimiento incremental. El proposal debería definir `output/timeline.json` como contrato canónico validado con Zod, `output/render-props.json` como derivado exclusivo de render, y agregar un paso `normalize:audio` antes de STT en `npm run pipeline`. La alineación debe producir `confidence` y warnings/fails por umbral; la selección de imágenes debe mejorar scoring y anti-repetición con `imagenes/metadata.json` opcional, usando placeholder solo con warning fuerte cuando no haya alternativa aceptable.

### Risks
- `ffmpeg-static` agrega peso y dependencia nativa/descarga npm, pero evita setup manual de FFmpeg en Windows.
- Si source audio no es WAV y faltan normalizados, STT/render necesitan normalización para tener duración confiable; permitir fallback directo sin probe puede degradar validación.
- Umbrales de alineación demasiado estrictos pueden frenar casos reales con STT imperfecto; conviene distinguir `warn` vs `fail` y registrar evidencia (`matchedWords`, ratio, fallback source).
- Metadata de imágenes mejora control, pero si se vuelve obligatoria rompe el flujo actual; debe ser opcional.
- `fix-timeline` hoy corrige silenciosamente; endurecer a fail en gaps/overlaps requiere decidir qué scripts pueden normalizar y cuáles solo validar.

### Ready for Proposal
Yes — listo para `sdd-propose`. El proposal debería excluir explícitamente UI/editor visual, subtítulos/captions y render de texto del guion; el guion solo define segmentos visuales separados por `|`.
