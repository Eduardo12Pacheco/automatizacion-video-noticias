# Política de seguridad

## Reportar una vulnerabilidad

Por favor, **no abras un issue público** por un problema de seguridad. Usa el formulario privado de
reporte de vulnerabilidades del repositorio (pestaña **Security** de GitHub → **Report a vulnerability**)
e incluye:

- la versión, el archivo o la ruta afectada;
- los pasos para reproducirla, idealmente contra un stack demo local;
- el impacto que crees que tiene;
- si el problema ya es público.

Puedes esperar un acuse de recibo en unos pocos días. Es un proyecto de portafolio mantenido por una
sola persona; no hay soporte de pago ni SLA. Por favor, da una ventana razonable para publicar una
corrección antes de divulgar los detalles.

## Versiones soportadas

Solo se soporta la última revisión de `feat/local-first-product` / de `main` publicada. No hay ramas de
largo plazo ni backports.

## Valores de seguridad por defecto

El producto está diseñado para correr en un portátil, junto a su propietario, sin dependencia de la nube:

- **Loopback por defecto.** Los puertos publicados se enlazan a `${NEWSROOM_BIND:-127.0.0.1}`. Abrir el
  panel a una LAN es una decisión explícita, documentada en [docs/INSTALL.md](docs/INSTALL.md).
- **Sin servicios internos publicados.** Postgres, SearXNG, Mailpit, Ollama y n8n no se publican salvo que
  se active el perfil `debug` a propósito.
- **Secretos generados.** Los instaladores crean secretos aleatorios en `.env` (modo `0600`); Compose usa
  `${VAR:?run ./install.sh first}` en lugar de valores de respaldo débiles. `.env` nunca se versiona.
- **Autenticación real.** Los usuarios viven en la base de datos local con hashes de contraseña bcrypt; los
  roles `admin`, `editor` y `viewer` se aplican en el servidor mediante una única tabla de rutas y un único
  middleware de roles. Las sesiones son cookies HTTP-only y `SameSite=Lax`, con un almacén del lado del
  servidor que guarda hashes y tiene expiración.
- **El primer administrador lo crea el instalador.** No hay contraseña por defecto codificada, y las
  credenciales se imprimen una sola vez en el resumen del instalador.
- **Las mutaciones están protegidas.** Cada ruta del panel que muta datos exige sesión, el rol correcto y un
  Origin de confianza; los read models de auditoría, presencia y errores son solo para administradores. La
  única ruta autenticada que no tiene control de rol es `POST /panel/presence/heartbeat`, que solo escribe
  estado de presencia efímero. La limitación de intentos de login usa como clave el usuario más la IP del
  cliente, lee la dirección del cliente del salto de reenvío no confiable más a la derecha, y solo confía en
  `X-Forwarded-For` desde la dirección del propio contenedor del panel. Los bloqueos activos nunca se desalojan
  por una inundación de nombres de usuario, un bucket por IP respalda el bloqueo por usuario, y un
  restablecimiento de contraseña revoca todas las sesiones existentes de ese usuario.
- **Los workers internos exigen token.** El editor de aprobación, el renderer y el demo worker rechazan las
  llamadas de API sin el `x-api-key` generado por el instalador; las ejecuciones de desarrollo se enlazan a
  `127.0.0.1`. El gateway inyecta el token a través de la red de Compose.
- **Anti-framing y una CSP estricta.** El panel envía `X-Frame-Options: DENY`, `frame-ancestors 'none'`,
  `script-src 'self'` (sin scripts en línea), nosniff, una política de referrer del mismo origen y una política
  de permisos mínima. Los atributos de estilo en línea están permitidos porque los renderers de progreso y de
  línea de tiempo los establecen.
- **Guarda SSRF en las URLs descubiertas.** La extracción de artículos y las descargas de vista previa rechazan
  loopback, direcciones privadas, link-local, CGNAT, multicast, reservadas y sus equivalentes IPv6, los hosts de
  una sola etiqueta (nombres de servicio de Compose) y las redirecciones hacia esos destinos, tras la resolución
  DNS. Las descargas de medios además solo permiten hosts de YouTube de una lista blanca.
- **Contenedores sin root.** La API, el panel (nginx sin privilegios), el editor de aprobación, el renderer, el
  demo worker y los workers de CPU/GPU se ejecutan como usuarios sin root. La imagen de un solo uso `model-init`
  sigue como root porque escribe en los volúmenes de modelos que Docker crea como root; termina antes de que
  arranque el stack.
- **Modelos verificados por checksum.** Los archivos de modelo están fijados a revisiones de Hugging Face y se
  verifican contra las entradas SHA-256 de `infra/models/model-manifest.json`; una discrepancia aborta la
  instalación.
- **Los blobs subidos son inofensivos por defecto.** Solo el audio, el video y las imágenes raster se sirven en
  línea tras validar los bytes mágicos; cualquier otro tipo (incluidos HTML, SVG y XML) se sirve como adjunto
  `application/octet-stream` con `Content-Security-Policy: sandbox; default-src 'none'` y `nosniff`.
- **Sin endpoint de secretos.** `GET /panel/connectors` devuelve el estado de los adaptadores, nunca
  credenciales. Las sondas SMTP abren el saludo sin enviar correo.
- **Privacidad del historial.** Al historial público se le han eliminado rutas personales, dominios, claves y
  medios del propietario; ver [ADR 0007](docs/adr/0007-history-privacy.md). `gitleaks` se ejecuta sobre todas
  las refs en la compuerta final.

## Qué queda fuera del alcance

- Ataques que requieren que quien opera publique un puerto de depuración o interno a internet, o que ejecute
  con un `.env` modificado que elimina las variables requeridas.
- Vulnerabilidades de una imagen o un modelo de terceros que no forma parte de este repositorio; repórtalas
  aguas arriba.
- Denegación de servicio contra un portátil local de un solo usuario, salvo que también afecte a los valores
  por defecto del servidor incluido.
- Los fixtures de demo: son ficticios y deterministas a propósito.

## Si encuentras un secreto filtrado

No lo pegues en un issue. Repórtalo en privado como se indicó arriba. El propietario rota cualquier
credencial afectada; el historial del repositorio solo se reescribe con autorización explícita y un respaldo
nuevo, siguiendo [ADR 0007](docs/adr/0007-history-privacy.md).

## Licencia

Este proyecto se publica bajo la licencia MIT; ver [`LICENSE`](LICENSE).
