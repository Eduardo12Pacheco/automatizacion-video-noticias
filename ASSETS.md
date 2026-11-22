# Manifiesto de assets

Todo el contenido multimedia de este repositorio es material de demo ficticio para la versión de
portafolio. Los medios de marca originales del propietario, las superposiciones de transición extraídas
y la fuente de pantalla heredada **no** se incluyen a propósito.

## Assets de marca generados

Los archivos canónicos viven en `examples/brand/`; las copias del panel, del renderer y del editor de
aprobación las genera en tiempo de build o de ejecución
[`tools/assets/sync-runtime-assets.mjs`](tools/assets/sync-runtime-assets.mjs) (también lo ejecuta
`pnpm install` mediante `postinstall`) y las imágenes Docker. Las copias de runtime no se versionan, así
que los duplicados exactos no pueden divergir. Cada archivo listado abajo se genera de forma reproducible
con [`tools/assets/generate_demo_assets.py`](tools/assets/generate_demo_assets.py):

```sh
python tools/assets/generate_demo_assets.py
```

Requisitos: `ffmpeg`, `woff2_compress` y Pillow de Python. El generador elimina los metadatos de video y
audio (`-map_metadata -1`), y las imágenes fijas no contienen datos EXIF.

| Asset | Rol | Origen | Licencia |
|---|---|---|---|
| `examples/brand/logo-demo.webm` | Sintonía del logo con alfa (VP9, alfa) | Código generado | CC0 |
| `examples/brand/logo-demo-green.mp4` | Logo sobre pantalla verde para chroma key | Código generado | CC0 |
| `examples/brand/logo-demo.png` | Imagen fija del logo | Código generado | CC0 |
| `examples/brand/final-demo.mp4` / `.webm` | Tarjeta de cierre (30.12 s) | Código generado | CC0 |
| `examples/brand/particle-1..2.webm` | Bucles de superposición de polvo y partículas | Código generado | CC0 |
| `examples/brand/overlay-1..2.webm` | Bucles de superposición en modo screen/multiply | Código generado | CC0 |
| `examples/brand/transition-1..3.mp4` | Sustitutos de las transiciones de corte | Código generado | CC0 |
| `examples/brand/sfx/whip.wav`, `whoosh.wav`, `sting.wav` | Efectos de sonido de transición, sintetizados | Código generado | CC0 |
| `examples/brand/fonts/Demo-Display.woff2` | Fuente de titulares para la marca ficticia | Derivada de **Anton Regular** (SIL Open Font License 1.1) | OFL-1.1 |

Las copias de runtime (mismo origen y licencia, generadas por el script de sincronización) se escriben en:

- `services/renderer/assets/overlays/` — roles de render: `logo-primary.webm`, `logo-secondary.webm`,
  `logo-green.mp4`, `logo-clean.mp4`, `logo-final.png`, `outro-{primary,secondary,final}.mp4`,
  `particle-1..4.webm`, `overlay-layer-01/02.webm` + `.mp4`, las carpetas de fotogramas alfa del logo y las
  tres transiciones de corte.
- `services/renderer/public/` — `fonts/display/Demo-Display.woff2`, `sfx/sound-demo.wav` y el conjunto de
  efectos generados.
- `apps/panel/assets/` — previews para el navegador de los mismos roles, más `boundary-transitions/`.

El nombre de marca ficticio es **Demo Sports News**. Los roles de marca usan nombres neutros (`logo-primary`,
`logo-secondary`, `logo-final`, `outro-primary`, `outro-secondary`, `outro-final`); ningún país ni nombre de
torneo aparece en una ruta de asset.

Las imágenes fijas y las sintonías del logo generadas solo llevan el nombre de marca ficticio; no hay lema
de licencia, marca de agua ni sigla incrustados en la obra. El origen y la licencia se registran en este
manifiesto, y el generador es la fuente reproducible de cada archivo.

## Ícono del panel

| Asset | Rol | Origen | Licencia |
|---|---|---|---|
| `apps/panel/favicon.svg` | Favicon del navegador para Demo Sports News | SVG creado a mano en este repositorio | CC0 |

El ícono es una marca de transmisión original (un punto central con dos arcos de señal), no una copia de
ningún archivo del propietario.

## Licencias de fuentes

Todas las fuentes incluidas se distribuyen bajo la SIL Open Font License, versión 1.1. Un archivo `OFL.txt`
se encuentra junto a cada directorio de fuentes y contiene el aviso de copyright original más el texto
completo de la licencia:

| Directorio de fuentes | Fuentes | Archivo OFL |
|---|---|---|
| `services/subtitles/assets/fonts/subtitles/` | Anton, Bebas Neue, Khand, League Gothic, Oswald | `OFL.txt` |
| `examples/brand/fonts/` | `Demo-Display.woff2` (derivada de Anton) | `OFL.txt` |
| `apps/panel/assets/fonts/display/` | `Demo-Display.woff2` | `OFL.txt` |
| `apps/panel/assets/fonts/inter/` | Inter | `OFL.txt` |
| `apps/panel/assets/fonts/jetbrains-mono/` | JetBrains Mono | `OFL.txt` |
| `services/renderer/public/fonts/display/` | `Demo-Display.woff2` | `OFL.txt` |

`Demo-Display.woff2` es un reempaquetado renombrado y subconjunto de la fuente Anton, licenciada bajo OFL;
las reglas de nombre reservado no aplican porque el aviso de copyright de Anton no declara un Reserved Font
Name. La tipografía de pantalla generada conserva el aviso OFL y no puede redistribuirse bajo otra licencia.

## Referencia de voz para GPU

`services/tts-worker/refs/voz.wav` + `voz.txt` son una muestra de habla sintética de 6.1 segundos que usa
como referencia de clonación de voz el motor GPU Qwen3-TTS. Son generados, no grabados: el texto de
`voz.txt` se sintetiza con la voz `es_ES-davefx-medium` de Piper (el mismo modelo de voz compatible con GPL
que descarga el modo CPU; el audio generado no es copia de ninguna grabación).

```sh
docker run --rm -v newsroom_piper_models:/models/piper \
  newsroom-tts-worker:latest \
  sh -c 'cat refs/voz.txt | piper -m /models/piper/es_ES-davefx-medium/es_ES-davefx-medium.onnx -f refs/voz.wav'
```

El modo Piper en CPU ignora ambos archivos; el motor GPU los necesita porque Qwen clona una voz de
referencia en lugar de usar un locutor fijo.

## Demo grabada

`docs/images/demo.gif` (bucle corto) y `docs/images/demo.mp4` (recorrido de 67 segundos, 1440x900) son
grabaciones de pantalla del panel en **modo demo** sobre el stack sin claves, en español y con la historia
ficticia sembrada: inicio de sesión, Guiones, Voz (un job de voz real que llega a "Completado" al 100 %),
Subtítulos, el editor de guiones y Ajustes. Son capturas del producto, no medios de marca, y solo contienen
datos ficticios de demo.

La grabación es reproducible y solo captura el viewport de la app:

```sh
export NEWSROOM_ENV_FILE=e2e/.env.example
export E2E_COMPOSE_ENV=e2e/.env.example
docker compose --env-file "$E2E_COMPOSE_ENV" up -d --build postgres searxng mailpit demo-worker approval-editor api panel
docker compose --env-file "$E2E_COMPOSE_ENV" run --rm migrate
docker compose --env-file "$E2E_COMPOSE_ENV" run --rm seed
NEWSROOM_DEMO_PASSWORD=e2e-demo-password node tools/record-demo.mjs
```

`tools/record-demo.mjs` captura el viewport del navegador mediante Playwright, falla si la página registra un
error de consola o lanza una excepción, convierte la captura con `ffmpeg` (`-map_metadata -1`) y escribe el MP4
más el GIF optimizado de menos de 1 MB. Ambos archivos quedan muy por debajo del límite de 5 MB por blob que
se aplica al historial.

## No incluido

- Superposiciones, intros y cierres de marca hechos por el propietario, y la fuente de pantalla heredada.
- Superposiciones de transición extraídas de YouTube y música de terceros.
- Binarios de modelos, cachés ni salidas de render generadas.
