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

> Si FlashAttention no instala en tu entorno, podés correr sin flash-attn.

## Uso

1. Guardar guion en `input/mi-guion.txt`
2. Guardar referencia de voz en `refs/voz.wav`
3. Guardar transcripción de referencia en `refs/voz.txt`

```bash
python src/main.py --input input/mi-guion.txt --ref-audio refs/voz.wav --ref-text refs/voz.txt
```

Salida:

- Audio final: `output/run-YYYYMMDD-HHMMSS.wav`
- Reporte: `output/run-YYYYMMDD-HHMMSS.report.json`
- Segmentos intermedios: `segments/run-YYYYMMDD-HHMMSS/*.wav`

## Notas

- Modelo inicial: `Qwen/Qwen3-TTS-12Hz-0.6B-Base`.
- Idioma objetivo por defecto: `Spanish`.
- La duración total final es libre (no se fuerza tiempo).
- El sample rate final queda exactamente como lo devuelve Qwen.
