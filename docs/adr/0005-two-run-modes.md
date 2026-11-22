# ADR 0005 — Dos modos reales de ejecución: demo y local

## Estado

Aceptada.

## Contexto

Quien visita el portafolio debe poder recorrer todo el producto sin GPU, sin descargar modelos y
sin clave de API. Al mismo tiempo, un recorrido con stubs deterministas no demuestra que el
pipeline funcione; la ruta de IA local tiene que ser real y comprobable. Un único build "solo demo"
ocultaría el producto real, y un build "solo local" haría que la primera experiencia fuera lenta y
frágil en una máquina desconocida.

## Decisión

Entregar dos modos de primera clase, seleccionados por `NEWSROOM_MODE` en un único composition root:

- **`demo`** (default del instalador): adaptadores deterministas de LLM, extracción de artículos,
  TTS, ASR, traducción y renderer, más una historia ficticia sembrada. Sin modelos ni descargas.
  El panel muestra el badge **Modo demo / Demo mode** y un banner, y el modo se expone en
  `/panel/bootstrap`.
- **`local`**: Ollama para la redacción de guiones y el clustering, trafilatura para la extracción,
  Piper para la voz en español en CPU, faster-whisper `small` int8 para los subtítulos y el renderer
  real de Remotion para un MP4 de 720p. El overlay `gpu` añade acceso a GPU y TTS con Qwen.

Ambos modos están cubiertos en CI: el happy path demo corre en cada push, y el modo local corre en
un job nocturno o manual con aserciones de `ffprobe` sobre el audio, los subtítulos y el video
reales. El instalador pregunta qué modo usar, y `newsroom mode demo|local` permite cambiarlo después.

## Consecuencias

- Quien visita el repositorio obtiene un producto funcional de inmediato; quien evalúa puede
  inspeccionar la ruta de IA real y su evidencia grabada.
- El modo demo no puede hacerse pasar en silencio por una ejecución real de IA: el badge se activa
  con el mismo modo que selecciona los adaptadores.
- Cada par de adaptadores debe mantener el mismo contrato de puertos, lo que exige la suite de
  contrato de los puertos de worker.
- El modo local depende de las descargas de modelos y del rendimiento de la máquina; el job nocturno
  es más lento que la suite demo rápida y está separado a propósito.
