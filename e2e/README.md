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
cp e2e/.env.example .env
docker compose up -d --build postgres searxng mailpit demo-worker api panel
docker compose run --rm seed
pnpm install --frozen-lockfile
pnpm exec playwright install chromium   # or set PLAYWRIGHT_CHROMIUM_EXECUTABLE
pnpm exec playwright test
```

Use `docker compose down -v` between runs: the seed is idempotent but does not
reopen an already-approved topic, so a second E2E run needs a fresh demo
database.

All credentials in `e2e/.env.example` are fictional test values. Never reuse
them in a real installation.

## Local-mode happy path (real media)

`e2e/local-mode.spec.js` is the D10 acceptance run. It is opt-in because it
downloads the local models and renders real media on CPU:

```bash
cp e2e/.env.example .env
# set NEWSROOM_MODE=local, LLM=ollama, ARTICLE_EXTRACTOR=trafilatura,
# TTS_WORKER_ENGINE=piper and COMPOSE_PROFILES=local in .env
docker compose --profile local run --rm model-init
docker compose --profile local run --rm --no-deps --entrypoint /bin/ollama \
  ollama pull qwen2.5:3b-instruct
docker compose --profile local up -d --build postgres searxng mailpit \
  demo-worker approval-editor ollama asr-worker tts-worker subtitles \
  renderer api panel
docker compose run --rm seed
NEWSROOM_E2E_LOCAL=1 pnpm exec playwright test e2e/local-mode.spec.js
```

It asserts the real pipeline with `ffprobe`: the synthesized WAV is at least
3 s and above silence, faster-whisper produces at least three cues containing
words from the script, the subtitles MP4 is H.264, and the final Remotion MP4
is 1280x720 with audio and video streams and at least 5 s. The same spec runs
nightly in `.github/workflows/local-mode.yml`.

The renderer fetches the synthesized voice and the still image from a
throwaway `python:3.12-slim` static server that the test starts on the Compose
network, mounted on the test work directory. It needs Docker access on the
machine running the spec; set `E2E_FIXTURE_NETWORK` if the Compose project is
not named `newsroom`.
