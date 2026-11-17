# Editorial panel

The browser UI of Newsroom Video Automation: plain HTML, CSS and ES modules
with no build step. It is served by the bundled `panel` container (nginx) and
talks only to `apps/api` on the same origin. Configuration and session state
come from `/panel/bootstrap` and `/panel/session`; the browser never talks to a
worker or database directly.

## What it does

- **Prensa** reviews discovered news, channels and search refresh.
- **Guiones** approves topics and edits, publishes or downloads script drafts.
- **Voz** runs speech synthesis jobs and manages the generated audio.
- **Subtítulos** aligns, previews and burns captions.
- **Proyectos** composes brand assets, overlays, captions and audio for the
  final Remotion render.
- **Administración** holds users, connectors, active users and the error audit,
  all admin-only.

The full product, install instructions and architecture are in the repository
[README](../../README.md) and [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

## Layout

```text
apps/panel/
├─ index.html              # Shell, dialogs and stable DOM hooks
├─ assets/                 # Browser preview media and fonts
├─ js/
│  ├─ main.js
│  └─ modules/
│     ├─ composition-root.js
│     ├─ app-shell/        # lifecycle, navigation, events and view shell
│     ├─ core/             # auth, state, i18n, HTTP clients and UI helpers
│     ├─ features/         # approval, scripts, audio, subtitles, video projects, radar
│     ├─ shared/           # DOM and formatting helpers
│     └─ __checks__/       # executable parity checks
├─ styles/                 # tokens, base, layout, components and feature layers
├─ docs/parity/            # DOM, HTTP and style contracts
└─ tests/                  # pytest structural and behavioural guardrails
```

## Contracts

IDs and `data-action` values in `index.html` are public hooks. Feature modules
keep their `index.js` facade, CSS keeps its cascade order, and API calls keep
their method, headers and payload keys. See
[`docs/parity/contract-matrix.md`](docs/parity/contract-matrix.md) and
[`docs/parity/style-guards.md`](docs/parity/style-guards.md).

Translations live in `js/modules/core/i18n/es.json` and `en.json`; Spanish is
the default and the selected language is persisted in `localStorage`.

## Development

The supported way to run the panel is the local stack from the repository root:

```bash
./install.sh --mode demo
```

The installer prints the panel URL and the one-time administrator password.
For a contribution that only touches the panel shell, the visual suite serves
`apps/panel/` statically and needs no database:

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm test:visual
```

## Checks

```bash
pnpm test:panel      # pytest contracts and behavioural checks
pnpm test:checks     # node checks under js/modules/__checks__/
pnpm test:visual     # Playwright visual QA, axe and i18n matrix
```

The panel has no bundler and no build step: every file under `apps/panel/` is
served as written.
