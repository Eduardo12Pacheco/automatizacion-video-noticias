# ADR 0003 — n8n es opcional, no el backend

## Estado

Aceptada.

## Contexto

En el sistema original, n8n era el backend de dominio: 16 workflows, la mayoría CRUD por webhook
sobre RPC de Supabase, con las reglas de negocio en Code nodes. Eso hacía el sistema difícil de
probar, ataba el producto a una sola herramienta de orquestación y dejaba una gran cantidad de
lógica fuera de las pruebas versionadas. Además, n8n exige sus propias credenciales y clave de
cifrado.

## Decisión

Trasladar la lógica de los workflows a casos de uso de `packages/core` y mantener n8n solo como
adaptador opcional de `WorkflowTriggerPort`:

- La cola de jobs en proceso y el scheduler son dueños de la orquestación en el stack por defecto.
- El perfil de Compose `n8n` y los workflows de ejemplo simplificados siguen disponibles para
  quienes quieran disparar la API desde n8n.
- La exportación histórica se conserva en `examples/legacy-n8n/` como accesorio de referencia de
  solo lectura, con placeholders en lugar de secretos.

## Consecuencias

- El producto funciona con un único `docker compose up` y sin contenedor de n8n.
- El comportamiento de los workflows ahora está cubierto por pruebas ordinarias de casos de uso y
  de HTTP.
- Quien ya usa n8n puede mantener su herramienta como una capa delgada de disparo, pero ya no
  necesita entender un workflow de 38 nodos de Code para cambiar una regla de negocio.
- La exportación de referencia no es un respaldo de producción restaurable; las credenciales y el
  volumen activo de n8n están intencionalmente ausentes.
