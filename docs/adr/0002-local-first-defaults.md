# ADR 0002 — Local-first defaults

## Status

Accepted.

## Context

The private deployment used Firecrawl, Serper, Gemini/OpenRouter, Supabase and
Google Drive. The owner asked for a version that runs as locally as reasonably
possible, with external services only as optional adapters where no acceptable
local option exists. The target machine has an 8 GB RTX 4060, Docker and no
requirement to keep the old cloud accounts.

## Decision

Make the default configuration require **zero API keys and zero cloud
accounts**:

- Ollama is the default LLM, with any OpenAI-compatible endpoint as an optional
  adapter.
- trafilatura extracts article text locally.
- SearXNG plus Wikimedia Commons provides keyless image search.
- Postgres runs in a container with tracked SQL migrations.
- Blobs live on the local filesystem and are served by the API.
- faster-whisper, Qwen TTS and Piper provide local speech services.
- yt-dlp is the only media download path.
- Console/Mailpit provides notifications; SMTP is the optional real-inbox
  adapter.
- n8n is optional and off by default.

A capability that is disabled or unavailable returns a typed
`adapter_unavailable` error while read/save surfaces keep working.

## Consequences

- `docker compose up` and the installers need no accounts, keys or paid tier.
- Local quality and speed depend on the machine; a 7B model is slower than a
  hosted model, and CPU Piper is less expressive than GPU Qwen.
- The installers must download several models, so first install takes longer
  than a typical web app.
- External services remain possible through environment configuration, which
  keeps the architecture honest for users who prefer them.
