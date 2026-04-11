# Voice Lab Qwen (CLI)

MVP local para clonación de voz con **Qwen3-TTS Base** en una carpeta separada de `voice-lab`.

Este proyecto mantiene lo acordado:

- No toca Chatterbox.
- Entrada de guion en `.txt` obligatoria.
- `ref_text` obligatorio para mejor fidelidad de clonación.
- Segmentación **paragraph-first** con split por oración cuando el párrafo queda largo.
- Salida al sample rate **nativo del modelo** (sin resampling manual).

## Estructura

- `config/default.yaml` - reglas de segmentación, pausas y parámetros de generación.
- `src/segmenter.py` - segmentación paragraph-first por rango de palabras.
- `src/generate.py` - wrapper de Qwen3-TTS Base para voice clone.
- `src/assemble.py` - ensamblado final con pausas y crossfade.
- `src/main.py` - CLI end-to-end.

## Requisitos

```bash
pip install -r requirements.txt
```

> Esta configuración está en modo estricto para 1.7B: si activás FlashAttention y no está disponible, la ejecución falla (sin fallback automático).

## Uso

1. Guardar guion en `input/mi-guion.txt`
2. Guardar referencia de voz en `refs/voz.wav`
3. Guardar transcripción de referencia en `refs/voz.txt`

```bash
python src/main.py --input input/mi-guion.txt --ref-audio refs/voz.wav --ref-text refs/voz.txt
```

Para elegir preset en CLI:

```bash
python src/main.py --input input/mi-guion.txt --ref-audio refs/voz.wav --ref-text refs/voz.txt --preset balanced_default
```

Si no pasás `--preset`, el sistema usa `generation.preset` del YAML.

Salida:

- Audio final: `output/<model-tag>/run-YYYYMMDD-HHMMSS.wav`
- Reporte: `output/<model-tag>/run-YYYYMMDD-HHMMSS.report.json`
- Segmentos intermedios: `segments/<model-tag>/run-YYYYMMDD-HHMMSS/*.wav`

## Notas

- Modelo por defecto: `Qwen/Qwen3-TTS-12Hz-1.7B-Base`.
- Idioma objetivo por defecto: `Spanish`.
- La duración total final es libre (no se fuerza tiempo).
- El sample rate final queda exactamente como lo devuelve Qwen.
- El reporte incluye benchmark básico: tiempo total, carga de modelo+referencia y síntesis por segmento.

## Presets disponibles

- `fidelity_strict`: más similitud y estabilidad, menos variación.
- `balanced_default`: equilibrio entre clonación y naturalidad (recomendado para iniciar).
- `expressive_plus`: más vida/entonación, con mayor riesgo de desviación.
