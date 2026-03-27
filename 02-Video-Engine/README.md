<p align="center">
  <img src="./Image-Proyect-RemotionEditor.png" alt="RemotionEditor" />
</p>

<h1 align="center">RemotionEditor</h1>

Pipeline automático para generar videos en Remotion a partir de:

- un **guion** (`guion/script.txt`, separado por `|`),
- un **audio de transcripción** (`audio/audio-16khz.wav`),
- un **audio de render final** (`audio/audio-48khz.wav`),
- y una carpeta de **imágenes** (`imagenes/`).

El sistema analiza el guion, transcribe audio con timestamps reales, alinea frases con tiempo, arma timeline y renderiza el video final.

---

## 🚀 Stack / Tecnologías

- **Node.js + npm**
- **Remotion 4** (render de video en React)
- **Python** (scripts de STT y utilidades)
- **faster-whisper** (STT principal)
- **Vosk** (fallback compatible)

---

## 📁 Estructura esperada

```txt
.
├─ guion/
│  └─ script.txt
├─ audio/
│  ├─ audio-16khz.wav   # STT (Whisper)
│  └─ audio-48khz.wav   # Render final (mejor calidad)
├─ imagenes/
├─ output/
└─ scripts/
```

---

## ⚙️ Instalación

Desde la raíz del proyecto:

```bash
npm install
npm run install:python-deps
```

Si vas a usar fallback Vosk y no tenés modelo descargado:

```bash
npm run download:vosk-model
```

---

## ▶️ Ejecución (flujo recomendado)

1. Ejecutar pipeline completo:

```bash
npm run pipeline
```

2. Renderizar video final:

```bash
npm run render:video
```

Salida esperada:

- `output/video-final.mp4`

---

## 🧠 ¿Qué hace el pipeline?

`npm run pipeline` ejecuta, en orden:

1. `setup-project` → valida/crea estructura base.
2. `process-script` → separa guion por frases y asigna imágenes por keywords.
3. `transcribe-audio` → transcribe con Whisper y obtiene timestamps reales.
4. `align-phrases` → fusiona frases + transcript en tiempos por frase.
5. `generate-timeline` → construye timeline base.
6. `fix-timeline` → corrige bordes para evitar huecos/solapamientos.
7. `verify-sync` → valida sincronización final.

---

## 📦 ¿Qué significa cada archivo en `output/`?

- **`script-phrases.json`**
  - Frases del guion + keywords + imagen sugerida por frase.

- **`transcript.json`**
  - Transcripción del audio con `segments` y `words` con `start/end`.
  - Incluye backend usado (`whisper`, fallback, etc.).

- **`phrase-timestamps.json`**
  - Fusión de guion y transcript: cada frase queda con `startTime` / `endTime`.

- **`timeline.json`**
  - Timeline limpio para video (`frames[]` con imagen, frase y tiempos).

- **`render-props.json`**
  - Props finales para Remotion (rutas normalizadas + segmentos + audio fuente).

- **`video-final.mp4`**
  - Video renderizado final.

---

## 🔊 Convención de audio (importante)

- `audio/audio-16khz.wav` → usado para STT.
- `audio/audio-48khz.wav` → usado para render final.

Fallback de render:

1. intenta `audio-48khz.wav`
2. si no existe, usa `audio-16khz.wav`

Además, el último frame se extiende hasta la duración real del audio de render para evitar cortes prematuros.

---

## 🛠️ Comandos útiles

```bash
# Desarrollo Remotion Studio
npm run dev

# Diagnóstico de backends STT disponibles
npm run diagnose:stt

# Test de utilidades de alineación
npm test

# Verificar lint + tipos
npm run lint
```

---

## ✅ Formatos de imagen soportados

En el flujo actual se manejan correctamente:

- `.png`
- `.jpg`
- `.jpeg`
- `.webp`
- `.svg`

Si no encuentra imagen válida para una frase, se usa placeholder.

---

## 📌 Nota de uso

Para mejores resultados:

- mantené frases claras en el guion separadas por `|`,
- usá imágenes con nombres descriptivos,
- y verificá que ambos audios (16k y 48k) correspondan al mismo contenido y duración.
