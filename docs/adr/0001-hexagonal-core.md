# ADR 0001 — Núcleo hexagonal con puertos y adaptadores

## Estado

Aceptada.

## Contexto

El producto original ponía las reglas de negocio dentro de Code nodes de n8n, un archivo de
gateway de 1.981 líneas y llamadas del navegador a Supabase. Eso hacía imposible probar el
dominio sin servicios externos, duplicaba el código de Whisper, YouTube y yt-dlp entre
servicios y creaba una dependencia circular entre el panel y el motor de video. La
reconstrucción necesita un único lugar para las reglas y una forma sencilla de cambiar una
capacidad en la nube por una local.

## Decisión

Usar una arquitectura hexagonal:

- `packages/core` es dueño de los casos de uso, las reglas de dominio, la cola de jobs y los
  puertos que consumen esos casos de uso.
- `packages/data` es dueño de `RepositoryPort` y `BlobStoragePort`, con adaptadores en memoria,
  Postgres y filesystem.
- `packages/adapters` es dueño de las implementaciones locales-first de los puertos externos
  (LLM, extracción de artículos, búsqueda de imágenes, RSS, descarga de medios, exportación de
  documentos, notificaciones y el disparador opcional de n8n).
- `apps/api` es el único adaptador HTTP de entrada. Un único composition root selecciona los
  adaptadores desde variables de entorno.
- Las dependencias apuntan hacia adentro: el core nunca importa un adaptador, un cliente de base
  de datos ni código del navegador.

Las pruebas inyectan mocks definidos en el archivo o el repositorio en memoria. La misma suite
de contrato del repositorio corre contra Postgres cuando `TEST_DATABASE_URL` está configurada.

## Consecuencias

- El comportamiento del dominio queda cubierto por pruebas rápidas y deterministas, sin red.
- Una capacidad local puede reemplazarse o desactivarse (`LLM=none`, `NOTIFY=none`) sin cambiar
  los casos de uso.
- El composition root tiene más código de cableado, y cada nueva capacidad necesita un puerto y
  al menos un adaptador.
- Los antiguos workflows de n8n pasan a ser código ordinario, así que pueden revisarse,
  versionarse y probarse como el resto del repositorio.
