# Conectores

Cada integración externa del producto es un adaptador detrás de un puerto. El composition
root de `packages/adapters/src/composition.js` (runtime de la API) y de
`apps/api/src/composition.js` (capa de datos) selecciona un adaptador por puerto a partir de
variables de entorno. Los adaptadores locales son el default, y cada conector opcional está
apagado hasta que lo configuras.

En `NEWSROOM_MODE=demo` el composition root fuerza los adaptadores demo deterministas (LLM,
extracción, TTS, ASR, traducción y renderer) sin importar los valores de abajo, para que el
badge del panel nunca mienta sobre una ejecución. El registro de conectores sigue informando
los adaptadores configurados para inspección. En `NEWSROOM_MODE=local` los valores de abajo
seleccionan los adaptadores reales.

El panel muestra el adaptador activo y el estado de cada puerto en
**Administración → Conectores** (solo admin). `GET /panel/connectors` devuelve el catálogo sin
credenciales, y `POST /panel/connectors/:id/test` ejecuta una sonda acotada. Los estados significan:

| Estado | Significado |
|---|---|
| `local` | Un adaptador local incluido está activo (Ollama, filesystem, RSS, …). |
| `configured` | Un adaptador opcional está configurado (SMTP, n8n, S3, LLM compatible con OpenAI, …). |
| `disabled` | El puerto no tiene adaptador (`*_ADAPTER=none` / `LLM=none`). |
| `error` | La última prueba de conexión falló. Los detalles quedan en el panel; no se devuelve ningún secreto. |

Compose y una ejecución nativa de `node apps/api/src/gateway.js` leen todas las variables desde
`.env`. Reinicia la API después de cambiar una.

## Vista general

| Conector | Interruptor de entorno | Default | Qué hace |
|---|---|---|---|
| Ollama / cualquier LLM compatible con OpenAI | `LLM=ollama\|openai` | Ollama local | Guiones, clustering, clasificación |
| SMTP / Gmail | `NOTIFY=smtp` | Consola | Correo de notificación (Gmail usa una contraseña de aplicación) |
| S3 / MinIO | `STORAGE=s3` | Filesystem | Almacenamiento de blobs para subidas y renders |
| n8n | `WORKFLOW=n8n` | Desactivado | Disparador por cron (`POST /jobs/discover`) y webhook de job completado |

Todos los conectores opcionales están desactivados por defecto; sus credenciales vienen de
`.env` y nunca las devuelve la API ni se versionan en el repositorio.

## n8n (disparador de workflows)

Usa n8n solo como capa de cron y notificación; la lógica de dominio permanece en
`packages/core`. Los dos workflows compatibles están en `infra/n8n/workflows/` y se copian al
contenedor en `/workflows`.

```dotenv
WORKFLOW=n8n
N8N_WEBHOOK_BASE_URL=http://n8n:5678
N8N_WEBHOOK_TOKEN=                      # bearer opcional para los webhooks de n8n
JOBS_API_KEY=change-me                  # la mitad de la API del conector
NEWSROOM_NOTIFY_EMAIL=editor@example.local
```

Comandos:

```sh
docker compose --profile n8n up -d
docker compose exec n8n n8n import:workflow --input=/workflows/discover-cron.json
docker compose exec n8n n8n import:workflow --input=/workflows/job-completed-notification.json
```

- `discover-cron.json` se ejecuta todos los días a las 06:00 y llama a
  `POST $NEWSROOM_API_URL/jobs/discover` con `Authorization: Bearer
  $NEWSROOM_JOBS_TOKEN`. Define `NEWSROOM_JOBS_TOKEN` en el contenedor de n8n con el mismo
  valor que `JOBS_API_KEY`.
- `job-completed-notification.json` expone `POST /webhook/job-completed`. La API lo llama tras
  cada job de la cola cuando `WORKFLOW=n8n`. Adjunta una credencial SMTP al nodo de correo.

Orquestación única: la cola en proceso es siempre la única vía que ejecuta jobs, con o sin
n8n. `WORKFLOW=n8n` añade una notificación saliente `job-completed` y permite que n8n llame a
`POST /jobs/discover`; nunca encola una segunda copia de un job de borrador. Por eso bastan los
dos workflows incluidos: n8n dispara la API y recibe eventos, pero no es dueño del dominio.

Cómo probarlo:

```sh
curl -fsS -X POST http://127.0.0.1:8099/jobs/discover \
  -H "Authorization: Bearer $JOBS_API_KEY"
# 202 {"ok":true,"status":"accepted","run_id":"..."}
```

El botón **Conectores → n8n → Probar** del panel verifica `GET /healthz` en la instancia de
n8n. La exportación heredada de 16 workflows en `examples/legacy-n8n/` nunca la monta Compose
y no es compatible para uso en vivo.

## SMTP / Gmail (notificaciones)

El default es un adaptador de consola que registra una línea redactada por notificación.
Mailpit viene incluido en el stack por defecto para inspección local.

```dotenv
NOTIFY=smtp
SMTP_HOST=mailpit
SMTP_PORT=1025
SMTP_FROM=newsroom@example.local
SMTP_STARTTLS=false
SMTP_USER=
SMTP_PASS=
```

Gmail (o cualquier proveedor) usa una contraseña de aplicación, nunca la contraseña de la cuenta:

```dotenv
NOTIFY=smtp
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_STARTTLS=true
SMTP_USER=tu-direccion@gmail.com
SMTP_PASS=tu-contraseña-de-aplicación-de-16-caracteres
SMTP_FROM=tu-direccion@gmail.com
```

Cómo probarlo:

```sh
# Mailpit: abre http://127.0.0.1:8025 (perfil debug) o usa la API
curl -fsS http://127.0.0.1:8025/api/v1/messages

# Ejecuta el mismo contrato contra un servidor Mailpit o SMTP en vivo
NEWSROOM_LIVE_TESTS=1 SMTP_HOST=127.0.0.1 SMTP_PORT=1025 \
  node --test --test-name-pattern="SMTP notification" packages/adapters/test/live.test.js
```

El botón **Probar** del panel abre la conexión SMTP y lee el saludo (`EHLO`) sin enviar ningún
mensaje.

## LLM compatible con OpenAI (opcional, en la nube o autohospedado)

El LLM por defecto es Ollama en `http://localhost:11434` con `qwen2.5:3b-instruct`; no necesita
clave. En su lugar puede seleccionarse cualquier endpoint compatible con OpenAI:

```dotenv
LLM=openai
OPENAI_BASE_URL=https://api.example.com/v1
OPENAI_MODEL=tu-modelo
OPENAI_API_KEY=sk-...        # opcional para servidores locales compatibles con OpenAI
LLM_TIMEOUT_MS=300000
```

Ollama también expone un endpoint compatible con OpenAI, así que `LLM=openai` con
`OPENAI_BASE_URL=http://localhost:11434/v1` funciona sin clave.

Cómo probarlo:

```sh
node --test --test-name-pattern="local mock server" packages/adapters/test/llm.test.js
```

El botón **Probar** del panel llama a `GET {OPENAI_BASE_URL}/models`. La API nunca devuelve la
clave; solo se listan el nombre del adaptador, el modelo y la URL base.

## Almacenamiento de blobs compatible con S3 (MinIO, Garage, AWS S3)

El almacén de blobs por defecto es el filesystem local bajo `BLOB_ROOT` (`./data/blobs`). El
adaptador opcional guarda las mismas claves en un bucket compatible con S3; el navegador sigue
descargándolas desde `/panel/blobs/...`, así que nada más cambia.

```dotenv
STORAGE=s3
S3_ENDPOINT=http://minio:9000
S3_BUCKET=newsroom
S3_REGION=us-east-1
S3_ACCESS_KEY=newsroom                 # igual que MINIO_ROOT_USER
S3_SECRET_KEY=change-me                # igual que MINIO_ROOT_PASSWORD
```

La plantilla del instalador usa `__GENERATE_MINIO_ROOT_PASSWORD__`, de modo que el secreto del
cliente de la API y la contraseña raíz de MinIO se generan con el mismo valor.

Inicia MinIO y crea el bucket:

```sh
STORAGE=s3 docker compose --profile s3 up -d minio api panel
docker compose --profile s3 run --rm minio-init
```

El adaptador usa direccionamiento path-style y firma SigV4 con `crypto` de Node; no se instala
ningún SDK de AWS.

Cómo probarlo (la prueba en vivo parte de un bucket vacío y limpia su clave):

```sh
S3_TEST_ENDPOINT=http://127.0.0.1:9000 \
S3_TEST_BUCKET=newsroom \
S3_TEST_ACCESS_KEY=... \
S3_TEST_SECRET_KEY=... \
  node --test --test-name-pattern="MinIO" packages/data/test/s3-blob-storage.test.js
```

El botón **Probar** del panel hace un `HEAD` sobre el bucket.

## Adaptadores locales

Estos adaptadores son locales por diseño y no necesitan clave. Aparecen en el panel con estado
`local`; su botón **Probar** ejecuta una verificación local acotada.

| Puerto | Adaptador | Variables | Prueba |
|---|---|---|---|
| `NewsSourcePort` | Google News RSS | `NEWS_SOURCE=rss` | Sin sonda remota; el adaptador siempre está disponible. |
| `ArticleExtractorPort` | CLI de trafilatura | `ARTICLE_EXTRACTOR=trafilatura`, `PYTHON_BIN` | Disponibilidad del binario de Python. |
| `ImageSearchPort` | SearXNG + Wikimedia Commons | `IMAGE_SEARCH=searxng`, `SEARXNG_URL`, `IMAGE_SEARCH_WIKIMEDIA` | Una consulta mínima de imágenes. |
| `DocumentExportPort` | python-docx + Markdown | `DOCUMENT_EXPORT=local`, `DOCUMENT_ROOT` | Disponibilidad del binario de Python. |
| `TTSPort` | Worker Piper (CPU) / Qwen (GPU) | `TTS=worker`, `TTS_BASE_URL` | `GET /health`. |
| `ASRPort` | Worker faster-whisper | `ASR=worker`, `ASR_BASE_URL` | `GET /health`. |
| `TranslationPort` | Worker de subtítulos | `TRANSLATION=worker`, `SUBTITLES_BASE_URL` | `GET /api/subtitles/health`. |
| `VideoRendererPort` | Renderer de Remotion | `RENDERER=worker`, `RENDERER_BASE_URL` | `GET /health`. |
| `ChannelFeedPort` | RSS público de YouTube | `CHANNEL_FEED=rss` | Sin sonda remota. |
| `MediaDownloadPort` | yt-dlp a través del worker de ASR | `MEDIA_DOWNLOAD=worker`, `ASR_BASE_URL` | `GET /health`. |
| `AuthPort` | Auth del repositorio local | `AUTH=local` | Verificación del adaptador activo. |
| `RepositoryPort` | Postgres / en memoria | `DATABASE_URL` | Una consulta de lectura. |
| `BlobStoragePort` | Filesystem / S3 | `STORAGE`, `BLOB_ROOT` | Sonda de lectura/escritura o `HEAD` del bucket. |

Desactiva una capacidad con `LLM=none`, `IMAGE_SEARCH=none`, `NOTIFY=none`, `WORKFLOW=disabled`,
`TTS=none`, …; la API responde entonces con un `503` tipado solo en las operaciones que la
necesitan, y mantiene disponibles las superficies de lectura y guardado.
