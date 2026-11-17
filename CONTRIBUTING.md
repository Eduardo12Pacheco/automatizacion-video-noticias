# Contributing

Thanks for taking a look. This is a portfolio project, but it is built and
tested like a real product: small reviewable commits, deterministic tests and
honest documentation.

## Before you start

- Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and the ADRs under
  [`docs/adr/`](docs/adr/) so a change lands in the right package.
- Read [`docs/CONNECTORS.md`](docs/CONNECTORS.md) before adding an integration.
  New external capabilities go behind a port, with a local or demo adapter and
  a contract test.
- Never commit secrets, `.env` files, personal paths, owner brand media or
  third-party media without a documented license.

## Local setup

The full product runs through Docker Compose. For the test suites you only need
Node.js 22, pnpm and `uv` (Python is managed by `uv`) plus Docker for the demo
E2E:

```bash
git clone https://github.com/Eduardo12Pacheco/newsroom-video-automation.git
cd newsroom-video-automation
pnpm install --frozen-lockfile
```

Install the installer/CLI on your machine, or use the demo stack directly:

```bash
export NEWSROOM_ENV_FILE=e2e/.env.example
export E2E_COMPOSE_ENV=e2e/.env.example
docker compose --env-file "$E2E_COMPOSE_ENV" up -d --build postgres searxng mailpit demo-worker api panel
docker compose --env-file "$E2E_COMPOSE_ENV" run --rm seed
```

Do not copy `e2e/.env.example` over an installed `.env`: it replaces the
installer-generated secrets. Pass it with `--env-file` and the API picks it up
through `NEWSROOM_ENV_FILE`.

The panel is at <http://127.0.0.1:8080>. The installer path
(`./install.sh` / `.\install.ps1`) is documented in
[`docs/INSTALL.md`](docs/INSTALL.md).

## Tests

One command runs exactly what CI runs, with a summary table:

```bash
pnpm test:all
```

It covers every Node package, the panel pytest suite and its 42 `__checks__`
scripts, every Python service, the tools tests, the installer tests and the
Compose config. The demo Playwright happy path needs the running stack:

```bash
E2E_ALLOW_RESET=1 pnpm exec playwright test e2e/happy-path.spec.js e2e/panel-flows.spec.js
```

`E2E_ALLOW_RESET=1` is required by the destructive panel-flow reset and must
only be used against a disposable demo stack created for the E2E suite. Install
the pinned browser once with `pnpm exec playwright install chromium`; the specs
read `E2E_EDITOR_PASSWORD` when set and otherwise derive the seeded editor
password from `NEWSROOM_DEMO_PASSWORD` in the environment file.

The adapters suite shells out to `python-docx` through the system Python. If it
is missing locally the document-export test skips with the allow-listed
`missing-python-docx` reason; install it to run the real export check
(`python3 -m venv .venv-adapters && .venv-adapters/bin/pip install "python-docx>=1.1"`
and set `PYTHON_BIN`). CI installs it in the adapters job.

The visual-QA suite needs no Docker:

```bash
node tools/run-visual-qa.mjs
```

Focused commands:

```bash
pnpm test:panel
pnpm test:checks
node --test apps/api/test
uv run --project services/asr-worker --with pytest --with httpx pytest services/asr-worker/tests -q
bash infra/install/tests/run.sh
```

Every suite must stay green. Do not weaken a test to make it pass: either fix
the code, or update the test when it asserts obsolete behaviour and explain why
in the commit message. Skips are only acceptable for an optional runtime (for
example, no GPU) and must print the reason. Nested skips (individual tests that
skip inside a suite that otherwise runs) are reported separately by
`node tools/run-all-tests.mjs`; only the reasons declared in that runner are
allowed, and any other nested skip fails the run.

### What the Windows CI job proves

The `windows-installers` job runs on `windows-latest` with Docker Linux
containers unavailable, so it calls `./install.ps1 -Check -AllowMissingDocker`
and a dry run instead of installing the stack. It proves that the PowerShell
installer and CLI parse and load on Windows PowerShell, that the prerequisite
check reports missing Docker as a warning instead of failing, that the generated
`.env` and CLI paths work, and that the installer and parity PowerShell tests
(including `test_install_ps1.py` and `test_parity.py`) pass under a native
Windows `python`. It does **not** prove that Docker Desktop/WSL2 starts the
stack, that the Windows GPU path is exercised, or that the browser E2E runs on
Windows; those remain covered by the Linux jobs and by the installer's own
behaviour tests, not by a physical Windows host in this repository's CI.

## Code conventions

- Keep the architecture hexagonal: business rules in `packages/core`, adapters
  in `packages/adapters`, one composition root in `apps/api`. The core never
  imports an adapter, a database client or browser code.
- The panel is vanilla HTML/CSS/ES modules with no bundler. Use the tokens in
  `apps/panel/styles/tokens.css`; do not add raw colours, font sizes outside
  `--fs-*`, or a second UI font.
- Every user-facing string goes through the ES/EN i18n module. Generated
  editorial content is data and stays in its source language.
- Prefer small, cohesive files (target ≤ 600 lines) and delete dead code rather
  than keeping a compatibility shim.
- Keep new dependencies justified; the default install must stay keyless and
  local-first.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/):
`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`, `build:`, `ci:`.
Keep each commit a coherent work unit and include the tests that prove it. Do
not add `Co-Authored-By` or any AI attribution line.

## Pull requests

- Run `pnpm test:all` before opening the PR and paste the summary.
- Describe the behaviour change, the tests that cover it and any remaining gap.
- Do not push to `main` directly if the project owner has not asked for it, and
  never force-push or rewrite history. History rewrites require explicit owner
  authorization and the backup/gate procedure in
  [ADR 0007](docs/adr/0007-history-privacy.md).

## License

By contributing you agree that your contribution is released under the MIT
license in [`LICENSE`](LICENSE).
