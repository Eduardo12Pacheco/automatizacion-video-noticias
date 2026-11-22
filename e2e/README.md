# Camino feliz de extremo a extremo

La prueba de Playwright recorre una historia ficticia completa a través del stack por defecto, sin claves:

1. inicia sesión en la UI del panel como el editor sembrado;
2. abre un tema pendiente y lo aprueba desde la UI;
3. espera a que la API redacte el guion y luego procesa el borrador;
4. genera la voz (el worker demo de CPU devuelve un WAV);
5. crea, renderiza y descarga un MP4 con subtítulos;
6. crea, renderiza y descarga el MP4 final de demo en baja resolución.

El perfil de Compose por defecto usa el worker determinista `demo-worker` para los contratos que ven
los workers, así que esta prueba no necesita GPU, descarga de modelos ni claves de API. La misma prueba
también verifica los límites de la API y del proxy (`/panel`, `/tts`, `/subtitles`, `/remotion`).

## Ejecutar localmente

```bash
export NEWSROOM_ENV_FILE=e2e/.env.example
export E2E_COMPOSE_ENV=e2e/.env.example
docker compose --env-file "$E2E_COMPOSE_ENV" up -d --build postgres searxng mailpit demo-worker api panel
docker compose --env-file "$E2E_COMPOSE_ENV" run --rm seed
pnpm install --frozen-lockfile
pnpm exec playwright install chromium   # o define PLAYWRIGHT_CHROMIUM_EXECUTABLE
E2E_ALLOW_RESET=1 pnpm exec playwright test e2e/happy-path.spec.js e2e/panel-flows.spec.js
```

Nunca copies `e2e/.env.example` sobre un `.env` instalado: reemplazaría los secretos generados por el
instalador. El archivo E2E versionado se pasa con `--env-file` y lo carga la API mediante
`NEWSROOM_ENV_FILE`. Si ejecutas las specs contra un stack demo instalado, deja ambas variables sin
definir para que lean `.env`, y define `E2E_ALLOW_RESET=1` solo en un stack desechable.

La spec vuelve a sembrar la historia demo antes de empezar (`seed --reset`), así que pasa dos veces seguidas
contra el mismo stack. La spec de flujos del panel además restablece la contraseña del administrador del E2E,
por lo que se niega a ejecutarse sin `E2E_ALLOW_RESET=1`. `E2E_EDITOR_PASSWORD` sustituye la contraseña del
editor; si no se define, las specs leen `NEWSROOM_DEMO_PASSWORD` del archivo de entorno.
`docker compose down -v` sigue siendo la forma limpia de empezar con una base de datos vacía.

Todas las credenciales de `e2e/.env.example` son valores de prueba ficticios. Nunca los reutilices en una
instalación real.

## Volver a grabar la demo del README

`tools/record-demo.mjs` graba el mismo stack demo desde el viewport de la app (sin escritorio ni terminal) y
escribe `docs/images/demo.mp4` más el GIF de menos de 1 MB:

```bash
NEWSROOM_DEMO_PASSWORD=e2e-demo-password node tools/record-demo.mjs
```

Usa un stack nuevo (`docker compose down -v` antes de `up`) para que la historia sembrada esté limpia. La
grabadora falla en lugar de entregar una grabación con un error de consola o una excepción de página.

## Camino feliz en modo local (medios reales)

`e2e/local-mode.spec.js` es la prueba de aceptación real del modo local. Es opt-in porque descarga los
modelos locales y renderiza medios reales en CPU:

```bash
cp e2e/.env.example e2e/.env.local
# En e2e/.env.local define NEWSROOM_MODE=local, LLM=ollama,
# ARTICLE_EXTRACTOR=trafilatura y TTS_WORKER_ENGINE=piper; la plantilla
# ya apunta NEWS_DISCOVERY_FEED_URL al servicio e2e-fixtures sin conexión.
export NEWSROOM_ENV_FILE=e2e/.env.local
export E2E_COMPOSE_ENV=e2e/.env.local
docker compose --env-file "$E2E_COMPOSE_ENV" --profile local run --rm model-init
docker compose --env-file "$E2E_COMPOSE_ENV" --profile local run --rm --no-deps --entrypoint /bin/ollama \
  ollama pull qwen2.5:3b-instruct
docker compose --env-file "$E2E_COMPOSE_ENV" --profile local --profile e2e up -d --build postgres searxng \
  mailpit demo-worker approval-editor ollama asr-worker tts-worker subtitles \
  renderer e2e-fixtures api panel
docker compose --env-file "$E2E_COMPOSE_ENV" run --rm seed
NEWSROOM_E2E_LOCAL=1 pnpm exec playwright test e2e/local-mode.spec.js
```

La spec es autocontenida: inicia el servicio de fixtures `e2e` (tres artículos inventados sin pubDate, así
que siempre son recientes) y recrea la API con
`NEWS_DISCOVERY_FEED_URL=http://e2e-fixtures:8000/discovery.xml` y un jugador inventado. Dispara una
actualización real del descubrimiento, demuestra que los nuevos clústeres provienen de los títulos del
fixture, aprueba uno de ellos y espera el borrador real de Ollama. Ese texto del borrador —obtenido de la
API, no escrito en el código— es la entrada para la voz de Piper, los subtítulos de faster-whisper y el
render de Remotion.

Cada artefacto de medios se mide con `ffprobe`/`ffmpeg`: el WAV dura al menos 3 s con volumen medio por encima
de −35 dB; las cues (al menos 3) cubren al menos el 40 % de sus palabras distintas no vacías del borrador; el
MP4 de subtítulos conserva el audio de la narración (volumen medio por encima de −35 dB); y el MP4 final de
Remotion dura al menos 5 s a 1280×720 con flujos de audio y video. La misma spec corre cada noche en
`.github/workflows/local-mode.yml`.

El renderer obtiene la voz sintetizada y la imagen fija desde un servidor estático `python:3.12-slim`
desechable que la prueba inicia en la red de Compose, montado sobre el directorio de trabajo de la prueba.
Necesita acceso a Docker en la máquina que ejecuta la spec. La red del servidor de medios se deriva de
`COMPOSE_PROJECT_NAME` (por defecto `newsroom`); define `E2E_FIXTURE_NETWORK` solo si quieres sustituirla
de forma explícita.

## QA visual

`e2e/visual-qa.spec.js` implementa la aceptación de QA visual en modo showcase: cada vista × {es,en} ×
{1440×900, 390×844}, sin errores de consola, sin peticiones fallidas, sin desbordes de diseño, sin texto de
depuración ni de respaldo, sin cadenas del catálogo en otro idioma y sin violaciones graves o críticas de
axe-core. También cubre la pantalla de inicio de sesión, los estados vacíos y de error diseñados, y los
esqueletos de carga, y escribe las capturas del README en `docs/images/screens/`.

No necesita el stack de Docker:

```bash
node tools/run-visual-qa.mjs
```

El runner inicia el servidor estático del panel, ejecuta Playwright y detiene el servidor. CI ejecuta el
mismo comando en el job `visual-qa`.
