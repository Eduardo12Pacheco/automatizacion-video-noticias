# Contribuir

Gracias por echar un vistazo. Es un proyecto de portafolio, pero se construye y se prueba como un
producto real: commits pequeños y revisables, pruebas deterministas y documentación honesta.

## Antes de empezar

- Lee [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) y los ADR de
  [`docs/adr/`](docs/adr/) para que un cambio caiga en el paquete correcto.
- Lee [`docs/CONNECTORS.md`](docs/CONNECTORS.md) antes de añadir una integración. Las nuevas
  capacidades externas van detrás de un puerto, con un adaptador local o demo y una prueba de
  contrato.
- Nunca subas secretos, archivos `.env`, rutas personales, medios de marca del propietario ni medios
  de terceros sin una licencia documentada.

## Configuración local

El producto completo corre con Docker Compose. Para las suites de pruebas solo necesitas Node.js 22,
pnpm y `uv` (Python lo gestiona `uv`), además de Docker para el E2E de demo:

```bash
git clone https://github.com/Eduardo12Pacheco/automatizacion-video-noticias.git
cd automatizacion-video-noticias
pnpm install --frozen-lockfile
```

Instala el instalador/CLI en tu máquina, o usa directamente el stack demo:

```bash
export NEWSROOM_ENV_FILE=e2e/.env.example
export E2E_COMPOSE_ENV=e2e/.env.example
docker compose --env-file "$E2E_COMPOSE_ENV" up -d --build postgres searxng mailpit demo-worker api panel
docker compose --env-file "$E2E_COMPOSE_ENV" run --rm seed
```

No copies `e2e/.env.example` sobre un `.env` instalado: reemplazaría los secretos generados por el
instalador. Pásalo con `--env-file`, y la API lo toma mediante `NEWSROOM_ENV_FILE`.

El panel está en <http://127.0.0.1:8080>. La ruta del instalador (`./install.sh` / `.\install.ps1`)
está documentada en [`docs/INSTALL.md`](docs/INSTALL.md).

## Pruebas

Un solo comando ejecuta exactamente lo que ejecuta CI, con una tabla de resumen:

```bash
pnpm test:all
```

Cubre cada paquete de Node, la suite pytest del panel y sus scripts `__checks__`, cada servicio en
Python, las pruebas de `tools`, las pruebas del instalador y la configuración de Compose. El happy path
de Playwright en demo necesita el stack en ejecución:

```bash
E2E_ALLOW_RESET=1 pnpm exec playwright test e2e/happy-path.spec.js e2e/panel-flows.spec.js
```

`E2E_ALLOW_RESET=1` es obligatorio para el reinicio destructivo de los flujos del panel, y solo debe
usarse contra un stack demo desechable creado para la suite E2E. Instala el navegador fijado una vez con
`pnpm exec playwright install chromium`; las specs leen `E2E_EDITOR_PASSWORD` si está definida y, si no,
derivan la contraseña del editor sembrado desde `NEWSROOM_DEMO_PASSWORD` en el archivo de entorno.

La suite de adaptadores invoca `python-docx` a través del Python del sistema. Si falta localmente, la
prueba de exportación de documentos se omite con el motivo permitido `missing-python-docx`; instálalo
para ejecutar la verificación real de exportación (`python3 -m venv .venv-adapters && .venv-adapters/bin/pip install "python-docx>=1.1"`
y define `PYTHON_BIN`). CI lo instala en el job de adaptadores.

La suite de QA visual no necesita Docker:

```bash
node tools/run-visual-qa.mjs
```

Comandos focalizados:

```bash
pnpm test:panel
pnpm test:checks
node --test apps/api/test
uv run --project services/asr-worker --with pytest --with httpx pytest services/asr-worker/tests -q
bash infra/install/tests/run.sh
```

Cada suite debe mantenerse en verde. No debilites una prueba para que pase: o corriges el código, o
actualizas la prueba cuando afirma un comportamiento obsoleto, y lo explicas en el mensaje del commit.
Los skips solo son aceptables para un runtime opcional (por ejemplo, sin GPU) y deben imprimir el motivo.
Los skips anidados (pruebas individuales que se omiten dentro de una suite que por lo demás corre) los
informa por separado `node tools/run-all-tests.mjs`; solo se permiten los motivos declarados en ese
runner, y cualquier otro skip anidado hace fallar la ejecución.

### Qué demuestra el job de Windows en CI

El job `windows-installers` corre en `windows-latest` sin contenedores Linux de Docker disponibles, así
que ejecuta `./install.ps1 -Check -AllowMissingDocker` y una ejecución en seco en lugar de instalar el
stack. Demuestra que el instalador y la CLI de PowerShell se parsean y cargan en Windows PowerShell, que
la verificación de prerrequisitos informa Docker ausente como advertencia en lugar de fallar, que el
`.env` generado y las rutas de la CLI funcionan, y que las pruebas de PowerShell del instalador y de
paridad (incluidos `test_install_ps1.py` y `test_parity.py`) pasan con el `python` nativo de Windows. **No**
demuestra que Docker Desktop/WSL2 levante el stack, que la ruta GPU de Windows se ejercite ni que el E2E
de navegador corra en Windows; eso sigue cubierto por los jobs de Linux y por las pruebas de
comportamiento del propio instalador, no por un host Windows físico en la CI de este repositorio.

## Convenciones de código

- Mantén la arquitectura hexagonal: las reglas de negocio en `packages/core`, los adaptadores en
  `packages/adapters` y un único composition root en `apps/api`. El core nunca importa un adaptador, un
  cliente de base de datos ni código del navegador.
- El panel es HTML/CSS/módulos ES nativos sin bundler. Usa los tokens de
  `apps/panel/styles/tokens.css`; no añadas colores crudos, tamaños de fuente fuera de `--fs-*` ni una
  segunda fuente de interfaz.
- Cada cadena visible para el usuario pasa por el módulo i18n ES/EN. El contenido editorial generado es
  dato y conserva su idioma de origen.
- Prefiere archivos pequeños y cohesivos (objetivo ≤ 600 líneas) y elimina el código muerto en lugar de
  conservar un shim de compatibilidad.
- Justifica cada dependencia nueva; la instalación por defecto debe seguir sin claves y ser local-first.

## Commits

Usa [Conventional Commits](https://www.conventionalcommits.org/):
`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`, `build:`, `ci:`.
Cada commit debe ser una unidad de trabajo coherente e incluir las pruebas que la demuestran.
Los mensajes de commit no deben llevar tráileres de coautoría ni de atribución de herramientas, como
`Co-Authored-By` o `Generated-by`; la línea de autor corresponde a la persona que hace el commit. La nota
de asistencia de IA del README describe cómo se construyó el proyecto, no es una convención de commits.

## Pull requests

- Ejecuta `pnpm test:all` antes de abrir el PR y pega el resumen.
- Describe el cambio de comportamiento, las pruebas que lo cubren y cualquier brecha restante.
- No hagas push directo a `main` si el propietario del proyecto no lo pidió, y nunca hagas force-push ni
  reescribas el historial. Las reescrituras del historial requieren autorización explícita del propietario
  y el procedimiento de respaldo y compuerta de
  [ADR 0007](docs/adr/0007-history-privacy.md).

## Licencia

Al contribuir aceptas que tu aporte se publique bajo la licencia MIT de
[`LICENSE`](LICENSE).
