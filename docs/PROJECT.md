# Contexto y alcance del proyecto

El contexto que no cabe en el [README](../README.md): de dónde viene el proyecto,
qué está verificado y qué no, las decisiones tecnológicas y un mapa del
repositorio.

## Historia del proyecto

La versión original de este producto funcionó unos tres meses en una redacción
periodística real, con n8n como backend, Supabase como almacén de datos y varias
claves de API de pago para extracción, búsqueda y modelos de lenguaje. Validó el
flujo y dejó una lección costosa: lo interesante era el pipeline editorial, no las
cuentas en la nube.

Este repositorio es una reconstrucción desde cero de ese sistema. Las reglas de
dominio pasaron de los Code nodes de n8n a casos de uso probados; el navegador
dejó de hablar directamente con Supabase; el código duplicado de Whisper, RSS y
descargas se unificó; la interfaz se reconstruyó sobre un sistema de diseño; y cada
capacidad externa se convirtió en un adaptador opcional detrás de un valor por
defecto local-first. El despliegue privado no está en marcha y no se enlaza desde
aquí.

La reconstrucción la implementó un agente de programación autónomo a partir de un
documento de especificación revisado, con pruebas, verificación local y revisión
humana en los puntos de decisión.

## Alcance honesto

- Este repositorio es una **reconstrucción de portafolio**, no un sistema en
  producción. Está diseñado para instalarse y ejecutarse localmente; nada se
  despliega en internet.
- Los dos modos de ejecución son reales y están probados: `demo` es determinista y
  no necesita modelos; `local` ejecuta los modelos locales reales y produce medios
  reales en CPU. La demo grabada corresponde al modo demo, y el panel lo indica así.
- Linux se prueba en el runner `ubuntu-latest` de CI y en la máquina Arch/CachyOS
  del autor. El instalador de Windows está cubierto por el job `windows-latest` de
  CI (parser, verificación de prerrequisitos y dry-run) y por pruebas de
  comportamiento de PowerShell 7 en Linux; no se ha ejecutado en un escritorio
  físico con Windows 10/11.
- El modo GPU está verificado en la máquina del autor (RTX 4060 de 8 GB, driver
  620.70, `nvidia-container-toolkit`): `docker run --rm --gpus all
  nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi` funciona, y el E2E de modo local
  pasó con medios reales de Ollama con CUDA, faster-whisper y Qwen3-TTS. El pico de
  memoria GPU de esa ejecución fue de 6646 MB de 8188 MB; la variante de voz de 1.7B
  cabe porque el LLM se descarga de inmediato y los trabajos GPU se serializan. El
  modo GPU no es más rápido de punta a punta que CPU (la síntesis de Qwen es más
  pesada y el render de Remotion sigue en CPU): la ejecución medida tardó 6.1 min
  frente a 5.2 min en CPU, mientras que el borrador del LLM bajó de 22.3 s a 5.1 s.
  Ver [Ejecución GPU verificada](INSTALL.md#ejecución-gpu-verificada).
- La interfaz, la navegación, el área de administración y cada pantalla de la suite
  de QA visual están traducidas a ES/EN. El contenido editorial generado (titulares,
  guiones, nombres de jugadores) conserva a propósito su idioma de origen.

## Stack tecnológico

| Capa | Elección | Por qué |
|---|---|---|
| UI | HTML, CSS y módulos ES nativos | Sin paso de build; fácil de inspeccionar en el navegador |
| API | Node.js en `apps/api` | Un solo backend es dueño de auth, sesiones, read models y la cola de jobs |
| Dominio | Casos de uso en `packages/core` + `packages/contracts` | Las reglas originales de n8n son código ordinario y probado |
| Datos | Postgres 16 + migraciones SQL versionadas | El mismo motor que Supabase, autohospedado y descartable en pruebas |
| IA local | Ollama, trafilatura, faster-whisper, Piper/Qwen | Corre en una sola máquina, con respaldo en CPU |
| Video | Remotion | Composiciones de marca programáticas y basadas en roles |
| Empaquetado | Docker Compose + `install.sh` / `install.ps1` + CLI `newsroom` | Una sola ruta de instalación para Linux y Windows |

Las razones de las decisiones principales están registradas en los [ADR](adr/).

## Mapa del repositorio

```text
apps/
  api/                 API HTTP, auth, sesiones, cola de jobs, composition root
  panel/               UI editorial en módulos ES nativos
packages/
  contracts/           Helpers de contratos compartidos y esquemas del editor
  core/                Casos de uso y puertos (el dominio)
  data/                Puertos de repositorio y blobs; adaptadores Postgres, en memoria y S3
  adapters/            Adaptadores locales-first y conectores opcionales
services/
  asr-worker/          Servicio faster-whisper (GPU/CPU) y descarga con yt-dlp
  tts-worker/          TTS de Piper en CPU y Qwen en GPU
  renderer/            Renderer final con Remotion
  subtitles/           Alineación y quemado de subtítulos
  channel-monitor/     Monitoreo de canales RSS públicos
  demo-worker/         Worker determinista sin claves para el perfil demo
infra/
  db/migrations/       Esquema SQL versionado
  n8n/                 Perfil opcional de n8n y dos workflows simplificados
  install/             Biblioteca compartida del instalador y sus pruebas
  windows/             Helpers opcionales de servicios de Windows
docs/                  Arquitectura, ADR, instalación, conectores y modelo de datos
examples/              Assets de marca ficticios y la referencia de n8n heredada
tools/                 Generador de assets, grabador de demo y pruebas estructurales
```

[docs/ARCHITECTURE.md](ARCHITECTURE.md#límites-de-código) describe la
responsabilidad de cada ruta y de qué puede depender.

## Resumen de pruebas

```bash
pnpm install --frozen-lockfile
pnpm test:all
```

`pnpm test:all` ejecuta las mismas suites que CI e imprime una tabla de resumen. Cubre
cada paquete de Node, la suite pytest del panel y sus scripts `__checks__`, cada
servicio en Python, las pruebas de `tools`, las pruebas del instalador y la
configuración de Compose. Las dos omisiones permitidas son el E2E de demo y
el E2E de modo local, que necesitan un stack en ejecución; CI las corre en sus propios
jobs, y `e2e/local-mode.spec.js` descarga los modelos reales y verifica con `ffprobe`
el audio, los subtítulos y el MP4 renderizados. La suite de QA visual corre sin Docker
contra el showcase. Todas las suites son bloqueantes en CI; no hay líneas base con
`continue-on-error`.

Ejemplos de ejecución focalizada:

```bash
pnpm test:panel
pnpm test:checks
node --test apps/api/test
uv run --project services/asr-worker --with pytest --with httpx pytest services/asr-worker/tests -q
pnpm exec playwright test e2e/happy-path.spec.js e2e/panel-flows.spec.js
```

La matriz completa de pruebas y las convenciones están en [CONTRIBUTING.md](../CONTRIBUTING.md);
la configuración del E2E de navegador está en [e2e/README.md](../e2e/README.md).

## Seguridad de un vistazo

Los puertos publicados se enlazan a `127.0.0.1` por defecto; los usuarios viven en
Postgres con hashes bcrypt y sesiones HTTP-only, y cada ruta que muta datos pasa por
un único control de rol con verificación de Origin de confianza. Los blobs subidos se
sirven con una CSP de sandbox y `nosniff`; solo el audio, el video y las imágenes
raster pueden mostrarse en línea, mientras que HTML, SVG y XML se fuerzan como
descargas `application/octet-stream`. La lista completa y el modelo de amenazas están
en [SECURITY.md](../SECURITY.md).
