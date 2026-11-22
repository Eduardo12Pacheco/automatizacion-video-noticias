# ADR 0006 — Los conectores son puertos de primera clase

## Estado

Aceptada.

## Contexto

El sistema original acoplaba el producto a proveedores concretos: n8n era dueño de los workflows,
Supabase de los datos, Firecrawl y Serper extraían y buscaban, y un modelo en la nube redactaba los
guiones. Reemplazar uno de ellos significaba editar reglas de negocio. La reconstrucción ya tenía
puertos para las capacidades del core, pero las integraciones solo podían descubrirse leyendo `.env`
y el composition root; quien operaba el sistema no podía ver qué estaba activo ni si funcionaba.

## Decisión

Tratar cada integración externa como un conector de primera clase:

- Un adaptador por puerto, seleccionado por entorno (`LLM`, `STORAGE`, `NOTIFY`, `WORKFLOW`, `AUTH`,
  …), con un default local y una implementación externa opcional.
- Un único registro (`createConnectorRegistry`) que informa `local`, `configured`, `disabled` o
  `error` para cada puerto, sin devolver credenciales.
- Una pantalla **Conectores / Connectors** solo para administradores, respaldada por
  `GET /panel/connectors` y `POST /panel/connectors/:id/test`, y la guía
  [docs/CONNECTORS.md](../../docs/CONNECTORS.md) con ejemplos de variables de entorno.
- Los conectores opcionales están desactivados por defecto. Los defaults locales no necesitan clave y
  siguen funcionando cuando un adaptador opcional está desactivado.
- n8n sigue siendo una capa de disparo y notificación, nunca un segundo ejecutor de jobs.

## Consecuencias

- Quien opera el sistema puede ver y probar el conjunto de integraciones activo desde la UI.
- Añadir un conector exige un contrato de puerto, una implementación local o demo, una prueba y una
  entrada en el registro; no puede ser una rama oculta dentro de un caso de uso.
- El registro y sus sondas forman parte de la superficie de seguridad: ningún secreto puede cruzar el
  endpoint, y cada sonda está acotada.
- Los conectores incluidos (Ollama/compatible con OpenAI, trafilatura, SearXNG, yt-dlp, python-docx,
  consola/SMTP, filesystem/S3, n8n) están documentados en un solo lugar en lugar de dispersos por el
  código.
