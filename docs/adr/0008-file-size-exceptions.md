# ADR 0008 — Excepciones de tamaño de archivo por encima de 600 líneas

## Estado

Aceptada (2026-11-12).

## Contexto

La ronda de verificación pidió que los archivos de producción de más de 600 líneas se dividieran en
módulos cohesivos, o que se mantuvieran en 800 líneas o menos con una justificación explícita. Varios
módulos son grandes pero tienen un alcance muy acotado: dividirlos aún más crearía capas de simple paso
o forzaría a exponer estado de runtime privado en objetos públicos.

## Decisión

Se dividieron los archivos de más de 800 líneas:

- `packages/data/src/adapters/in-memory-repository.js` ahora delega los métodos de usuarios, sesiones y
  proyectos de video en `in-memory-users.js`, `in-memory-video-projects.js` e `in-memory-shared.js`.
- `services/channel-monitor/app/workers.py` movió la limpieza por retención a `app/retention.py`.
- `services/renderer/src/remotion/Composition.tsx` movió la escena del periódico a `newspaper-scene.tsx` y
  el resolutor de presets de movimiento a `motion-range.ts`.

Los archivos de producción restantes entre 600 y 800 líneas no se dividen:

| Archivo | Líneas | Por qué mantenerlo junto es cohesivo |
|---|---|---|
| `services/channel-monitor/app/workers.py` | 795 | Las clases de worker comparten los contratos de store y ciclo de vida, y los predicados auxiliares; dividir una clase cada vez creó ciclos de importación antes de mover la retención. |
| `services/approval-editor/server.js` | 786 | Una sola máquina de estados de petición/respuesta HTTP sobre el mismo store de snapshots; las rutas y los helpers de persistencia solo tienen sentido juntos. |
| `services/channel-monitor/app/main.py` | 755 | Fábrica de la app FastAPI y superficie de rutas; dividir las rutas dispersaría un mismo grafo de dependencias. |
| `apps/panel/js/modules/features/video-projects/composition/composition-renderer.js` | 738 | Un solo ciclo de vida de composición en el navegador: DOM, sincronización de medios, overlays y callbacks de la línea de tiempo deben avanzar en paso. |
| `services/channel-monitor/app/youtube_client.py` | 729 | Parseo de metadatos y subtítulos de una misma API upstream, con una taxonomía de errores compartida. |
| `packages/data/src/adapters/in-memory-repository.js` | 708 | Núcleo del repositorio (noticias, guiones, jobs de publicación) tras extraer los mixins de usuarios y video; los métodos restantes comparten los mismos mapas y el orden de las transacciones. |
| `services/subtitles/subtitles_service/api/routes/subtitles.py` | 700 | Un módulo de rutas sobre un solo store de sesiones; los handlers comparten la validación de peticiones y el nombrado de artefactos. |
| `services/renderer/src/remotion/Composition.tsx` | 651 | El árbol de composición de Remotion; dividir el grafo de escenas oscurecería el orden de capas. |
| `services/renderer/scripts/lib/render/video-engine-render-adapter.js` | 615 | Localización de assets local al renderer y comando de render; es el único pipeline de render del renderer. |
| `apps/api/src/gateway-server.js` | 611 | Composición del servidor HTTP y ciclo de vida de las peticiones; los módulos del gateway que llama ya son archivos separados. |
| `apps/panel/js/modules/features/subtitles/controller/table-editor.js` | 607 | Una sola tabla editable con estado compartido de foco, selección y portapapeles. |

## Consecuencias

El objetivo de 600 líneas queda documentado en lugar de ignorarse en silencio. Cualquier archivo que
crezca por encima de 800 líneas debe dividirse antes de la siguiente ronda de verificación.
