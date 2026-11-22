# ADR 0007 — Política de privacidad del historial

## Estado

Aceptada.

## Contexto

El repositorio conserva el historial real de commits de los proyectos privados originales. Eso tiene
valor para un portafolio —quien lo revisa puede ver cómo evolucionó el trabajo—, pero también significa
que un secreto o una ruta personal en un blob antiguo es tan accesible como uno en el árbol actual. Una
importación anterior limpió la mayoría de credenciales y medios, pero dejó pasar el prefijo de perfil de
Windows del propietario, y la compuerta final lo detectó.

## Decisión

La privacidad se aplica sobre **cada commit alcanzable**, no solo sobre `HEAD`:

- Reemplazar los prefijos de ruta del perfil personal de Windows por `<WORKSPACE>` y el dominio personal
  y los hosts de preview por `example.local`, tanto en el contenido de los archivos como en los mensajes
  de commit, en todas las ramas y refs de historial conservadas.
- Conservar los nombres y las fechas de autor originales; asignar los correos del propietario a la
  dirección noreply pública de GitHub para que las contribuciones sigan contando. Nunca reescribir una
  autoría no relacionada.
- Eliminar de todo el historial los secretos, las exportaciones de credenciales, las cookies, los archivos
  `.env`, los registros de auditoría de producción, los medios de marca del propietario, las superposiciones
  extraídas y los blobs de más de 5 MB.
- Condicionar la publicación a `gitleaks` sobre todas las refs, la comprobación del blob más grande, una
  comprobación de identidades, una prueba de deny-list de contenido y un escaneo de rutas y dominios.
  Vuelve a ejecutar la compuerta desde un clon nuevo antes de hacer push.
- Respaldar el repositorio previo a la limpieza antes de cualquier reescritura autorizada, y nunca modificar
  el respaldo.
- Mantener las capturas y los videos libres de datos personales: capturar solo el viewport de la app desde
  un `HOME` temporal, nunca un escritorio ni un prompt de terminal.

## Consecuencias

- Las reescrituras del historial son operaciones excepcionales y autorizadas, no correcciones rutinarias.
  Un patrón omitido exige una nueva autorización, un nuevo respaldo y una nueva ejecución de la compuerta.
- Los hashes de commit cambian durante una reescritura; el registro de la tarea guarda la correspondencia
  entre hashes antiguos y nuevos para cualquier referencia.
- El historial público sigue siendo útil como artefacto de portafolio sin filtrar el despliegue privado, sus
  cuentas ni la estructura de la máquina del propietario.
- La política es repetible: los mismos escáneres corren en la compuerta final y cualquiera que clone el
  repositorio puede volver a ejecutarlos.
