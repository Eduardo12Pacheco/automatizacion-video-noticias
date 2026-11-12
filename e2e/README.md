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
