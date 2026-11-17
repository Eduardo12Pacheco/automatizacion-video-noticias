# End-to-end happy path

The Playwright test drives one complete fictional story through the keyless
default stack:

1. log in through the panel UI as the seeded editor;
2. open a pending topic and approve it through the UI;
3. wait for the API to draft the script, then process the draft;
4. generate voice (the CPU demo worker returns a WAV);
5. create, render and download a subtitled MP4;
6. create, render and download the final low-res demo MP4.

The default Compose profile uses the deterministic `demo-worker` for the
worker-facing contracts so this test needs no GPU, model download or API key.
The same test also asserts the API and proxy boundaries (`/panel`, `/tts`,
`/subtitles`, `/remotion`).

## Run locally

```bash
export NEWSROOM_ENV_FILE=e2e/.env.example
export E2E_COMPOSE_ENV=e2e/.env.example
docker compose --env-file "$E2E_COMPOSE_ENV" up -d --build postgres searxng mailpit demo-worker api panel
docker compose --env-file "$E2E_COMPOSE_ENV" run --rm seed
pnpm install --frozen-lockfile
pnpm exec playwright install chromium   # or set PLAYWRIGHT_CHROMIUM_EXECUTABLE
E2E_ALLOW_RESET=1 pnpm exec playwright test e2e/happy-path.spec.js e2e/panel-flows.spec.js
```

Never copy `e2e/.env.example` over an installed `.env`: that would replace the
installer-generated secrets. The committed E2E file is passed with
`--env-file` and loaded by the API through `NEWSROOM_ENV_FILE`. If you run the
specs against an installed demo stack, leave both variables unset so they read
`.env`, and still set `E2E_ALLOW_RESET=1` only on a disposable stack.

The spec reseeds the demo story before it starts (`seed --reset`), so it passes
twice in a row against the same stack. The panel-flow spec additionally resets
the E2E administrator password and therefore refuses to run without
`E2E_ALLOW_RESET=1`. `E2E_EDITOR_PASSWORD` overrides the editor password; when
unset the specs read `NEWSROOM_DEMO_PASSWORD` from the environment file.
`docker compose down -v` is still the clean way to start from an empty database.

All credentials in `e2e/.env.example` are fictional test values. Never reuse
them in a real installation.

## Re-record the README demo

`tools/record-demo.mjs` records the same demo stack from the app viewport (no
desktop or terminal) and writes `docs/images/demo.mp4` plus the under-1-MB GIF:

```bash
NEWSROOM_DEMO_PASSWORD=e2e-demo-password node tools/record-demo.mjs
```

Use a fresh stack (`docker compose down -v` before `up`) so the seeded story is
clean. The recorder fails instead of shipping a recording with a console error
or a page exception.

## Local-mode happy path (real media)

`e2e/local-mode.spec.js` is the real local-mode acceptance run. It is opt-in because it
downloads the local models and renders real media on CPU:

```bash
cp e2e/.env.example e2e/.env.local
# In e2e/.env.local set NEWSROOM_MODE=local, LLM=ollama,
# ARTICLE_EXTRACTOR=trafilatura and TTS_WORKER_ENGINE=piper; the template
# already points NEWS_DISCOVERY_FEED_URL at the offline e2e-fixtures service.
export NEWSROOM_ENV_FILE=e2e/.env.local
export E2E_COMPOSE_ENV=e2e/.env.local
docker compose --env-file "$E2E_COMPOSE_ENV" --profile local run --rm model-init
docker compose --env-file "$E2E_COMPOSE_ENV" --profile local run --rm --no-deps --entrypoint /bin/ollama \
  ollama pull qwen2.5:3b-instruct
docker compose --env-file "$E2E_COMPOSE_ENV" --profile local --profile e2e up -d --build postgres searxng \
  mailpit demo-worker approval-editor ollama asr-worker tts-worker subtitles \
  renderer e2e-fixtures api panel
docker compose --env-file "$E2E_COMPOSE_ENV" run --rm seed
NEWSROOM_E2E_LOCAL=1 pnpm exec playwright test e2e/local-mode.spec.js
```

The spec is self-contained: it starts the `e2e` fixture service (three invented
articles with no pubDate, so they are always recent) and recreates the API with
`NEWS_DISCOVERY_FEED_URL=http://e2e-fixtures:8000/discovery.xml` and one
invented player. It triggers a real discovery refresh, proves the new clusters
come from the fixture titles, approves one of them and waits for the real Ollama
draft. That draft text — fetched from the API, not hardcoded — is the input for
Piper voice, faster-whisper subtitles and the Remotion render.

Every media artifact is measured with `ffprobe`/`ffmpeg`: the WAV lasts at least
3 s with mean volume above −35 dB, the cues (at least 3) cover at least 40 % of
their distinct non-stopword words in the draft, the subtitles MP4 keeps the
narration audio (mean volume above −35 dB), and the final Remotion MP4 lasts at
least 5 s at 1280×720 with audio and video streams. The same spec runs nightly
in `.github/workflows/local-mode.yml`.

The renderer fetches the synthesized voice and the still image from a
throwaway `python:3.12-slim` static server that the test starts on the Compose
network, mounted on the test work directory. It needs Docker access on the
machine running the spec. The media server network is derived from
`COMPOSE_PROJECT_NAME` (default `newsroom`); set `E2E_FIXTURE_NETWORK` only to
override it explicitly.

## Visual QA

`e2e/visual-qa.spec.js` implements the visual-QA acceptance in showcase mode: every
view × {es,en} × {1440×900, 390×844}, with zero console errors, zero failed
requests, no layout overflow, no debug/fallback copy, no foreign-language
catalog strings and no serious/critical axe-core violations. It also covers the
login screen, the designed empty/error states and the loading skeletons, and
writes the README screenshots to `docs/images/screens/`.

It needs no Docker stack:

```bash
node tools/run-visual-qa.mjs
```

The runner starts the static panel server, runs Playwright and stops the
server. CI runs the same command in the `visual-qa` job.
