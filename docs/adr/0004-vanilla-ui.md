# ADR 0004 — UI vanilla en lugar de reescribir en React

## Estado

Aceptada.

## Contexto

El panel es una aplicación grande de HTML/CSS/módulos ES nativos, con funciones reales: bandeja de
aprobación, editor de guiones, audio, subtítulos, proyectos de video, ajustes y administración. Sus
problemas eran visuales y estructurales —tipografía inconsistente, jerarquía de botones, colores,
diálogos, copy mezclado entre idiomas y accesibilidad—, no la falta de un framework de
componentes. Una reescritura en React costaría varias semanas y añadiría un paso de build a un
proyecto cuyo valor es el pipeline local.

## Decisión

Mantener el panel sobre HTML, CSS y módulos ES nativos, y mejorarlo en su lugar:

- Un único `tokens.css` con tokens de tipografía, color, espaciado y radio.
- Solo dos familias tipográficas: Inter para la interfaz y JetBrains Mono para timecodes e ids.
- Botones neutrales con variantes explícitas `.primary`, `.secondary`, `.ghost` y `.danger`.
- Un único patrón de diálogo, un módulo i18n (`es.json` / `en.json`), navegación ordenada según el
  pipeline y tres breakpoints responsivos.
- Vistas solo para administradores y presencia para el modelo local multiusuario.

El panel habla únicamente con `apps/api`, configurado desde `/panel/bootstrap`.

## Consecuencias

- No hay bundler, ni ciclo de actualizaciones de framework, ni capa de hidratación.
- El código de las funciones sigue siendo inspeccionable directamente en el navegador.
- Las pruebas de paridad y de comportamiento reemplazan algunas aserciones frozen que solo usaban
  grep.
- El equipo debe mantener disciplina con los tokens y con i18n; nada hace cumplir el sistema de
  diseño en tiempo de compilación. La prueba de contrato del sistema de diseño es la barrera de
  protección.
- Si la UI crece de forma sustancial, esta decisión debe revisarse en lugar de abandonarse en
  silencio.
