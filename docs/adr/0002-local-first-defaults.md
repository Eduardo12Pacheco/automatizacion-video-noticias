# ADR 0002 — Valores por defecto local-first

## Estado

Aceptada.

## Contexto

El despliegue privado usaba Firecrawl, Serper, Gemini/OpenRouter, Supabase y Google Drive. El
propietario pidió una versión que funcione de forma lo más local posible, con servicios externos
solo como adaptadores opcionales allí donde no existe una alternativa local aceptable. La máquina
objetivo tiene una RTX 4060 de 8 GB, Docker, y no hay requisito de mantener las cuentas en la nube
anteriores.

## Decisión

Hacer que la configuración por defecto requiera **cero claves de API y cero cuentas en la nube**:

- Ollama es el LLM por defecto; cualquier endpoint compatible con OpenAI es un adaptador opcional.
- trafilatura extrae el texto de los artículos en local.
- SearXNG más Wikimedia Commons proporciona búsqueda de imágenes sin claves.
- Postgres corre en un contenedor con migraciones SQL versionadas.
- Los blobs viven en el filesystem local y los sirve la API.
- faster-whisper, Qwen TTS y Piper proporcionan los servicios de voz locales.
- yt-dlp es la única vía de descarga de medios.
- Consola/Mailpit proporciona las notificaciones; SMTP es el adaptador opcional para una bandeja
  real.
- n8n es opcional y está desactivado por defecto.

Una capacidad desactivada o no disponible devuelve un error tipado `adapter_unavailable`, mientras
las superficies de lectura y guardado siguen funcionando.

## Consecuencias

- `docker compose up` y los instaladores no necesitan cuentas, claves ni un plan de pago.
- La calidad y la velocidad locales dependen de la máquina; un modelo de 7B es más lento que un
  modelo alojado, y Piper en CPU es menos expresivo que Qwen en GPU.
- Los instaladores deben descargar varios modelos, así que la primera instalación tarda más que
  en una aplicación web típica.
- Los servicios externos siguen siendo posibles mediante la configuración de entorno, lo que
  mantiene honesta la arquitectura para quien los prefiera.
