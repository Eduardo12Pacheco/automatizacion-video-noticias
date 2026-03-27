# Línea de tiempo de mejoras — RemotionEditor

## Contexto

Este documento resume, en orden cronológico, cómo fuimos detectando problemas y resolviéndolos durante la iteración del pipeline de generación automática de video.

---

## 1) Estado inicial y ejecución base

- Se revisó el flujo completo: guion → transcripción → alineación → timeline → render.
- Primeras ejecuciones mostraron bloqueos de entorno y de sincronización.

### Problemas detectados

- Faltaba audio en formato esperado para transcripción (`audio.wav` válido para STT).
- Faltaba modelo de STT local en algunas corridas.
- En algunas ejecuciones, el render fallaba por caché/bundling (`webpack wasm-hash`).

### Soluciones aplicadas

- Normalización de audio de entrada para STT.
- Descarga/configuración del modelo local cuando hizo falta.
- Limpieza de cachés de render (`node_modules/.cache`, `node_modules/.remotion`) cuando apareció el fallo de bundling.

---

## 2) Mejora de robustez en alineación temporal

### Problemas detectados

- Segmentos inválidos (`endTime <= startTime`) en ciertos casos de fallback.
- Esto rompía validaciones de sincronización y podía afectar timeline.

### Soluciones aplicadas

- Se reforzó la lógica de alineación para garantizar duración positiva mínima por segmento.
- Se añadieron/ajustaron tests para cubrir regresiones de alineación.

---

## 3) Hueco negro inicial antes de que empiece la voz

### Problema detectado

- Si la primera palabra aparecía tarde (ej. ~1.29s), quedaba negro desde `0.00` hasta ese punto.

### Sugerencia del usuario

- “La primera imagen debe arrancar en `0.00` sí o sí para evitar negro inicial”.

### Solución aplicada

- Se forzó que el primer bloque visual comience en `0.00` en la alineación.

### Resultado

- Eliminación del negro inicial.

---

## 4) Calidad de transcripción y fusión guion/transcript

### Observación clave

- Con el backend anterior, los tiempos eran aceptables pero el texto no siempre era suficientemente preciso.
- Eso afectaba la fusión fina entre `script-phrases` y `transcript`.

### Sugerencia del usuario

- Migrar a Whisper para mejorar texto y segmentación.

### Solución aplicada

- Migración a `faster-whisper` como backend preferido en modo `auto`.
- Se mantuvieron fallbacks para compatibilidad.

### Resultado

- Mejor transcripción (texto y timestamps por palabra) y mejor base para `phrase-timestamps`.

---

## 5) Estrategia de doble audio (calidad + precisión)

### Problema detectado

- El audio de render sonaba peor cuando se reutilizaba el archivo optimizado para STT.

### Sugerencia del usuario

- Usar dos audios con convención fija:
  - `audio-16khz.wav` para STT.
  - `audio-48khz.wav` para render final.

### Solución aplicada

- Se adoptó esa convención en el pipeline.
- Render prioriza `audio-48khz.wav` y hace fallback a `audio-16khz.wav` si falta.
- Transcripción usa `audio-16khz.wav` por defecto.

### Resultado

- Se conserva precisión para STT y se recupera calidad de audio en el video final.

---

## 6) Corte prematuro del video antes de terminar el audio

### Problema detectado

- El video terminaba en la última palabra detectada (~50.38s),
  pero el audio real duraba más (~51.65s).

### Sugerencia del usuario

- “La última imagen debe mantenerse hasta el final real del audio”.

### Solución aplicada

- En render, se calcula duración real del audio seleccionado.
- Se extiende el `endTime` del último frame hasta esa duración total.

### Resultado

- El video ahora finaliza exactamente cuando termina el audio.

---

## 7) Convenciones persistidas para próximas sesiones

- Se actualizó el skill registry del proyecto en:
  - `.atl/skill-registry.md`
- Se registraron reglas de operación:
  - audio dual (16k STT / 48k render),
  - no negro inicial,
  - sin huecos entre frames,
  - último frame hasta duración total del audio,
  - preferencia de Whisper en auto.

---

## Resumen personal

El avance fue incremental y muy guiado por feedback real del video.
Se mantuvo lo que ya funcionaba (animaciones, cobertura visual, continuidad)
y se corrigieron cuellos concretos: transcripción, alineación, calidad de audio,
inicio en 0.00 y cierre exacto al final del audio.
