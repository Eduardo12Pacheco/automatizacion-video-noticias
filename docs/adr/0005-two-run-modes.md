# ADR 0005 — Two real run modes: demo and local

## Status

Accepted.

## Context

A portfolio visitor must be able to click through the whole product without a
GPU, a model download or an API key. At the same time, a deterministic stub
walkthrough is not evidence that the pipeline works; the local AI path has to be
real and testable. A single "demo only" build would hide the actual product, and
a single "local only" build would make the first experience slow and fragile on
an unfamiliar machine.

## Decision

Ship two first-class modes selected by `NEWSROOM_MODE` in one composition root:

- **`demo`** (installer default): deterministic LLM, article extraction, TTS,
  ASR, translation and renderer adapters, plus a seeded fictional story. No
  models, no downloads. The panel shows a **Modo demo / Demo mode** badge and a
  banner, and the mode is exposed in `/panel/bootstrap`.
- **`local`**: Ollama for script writing and clustering, trafilatura for
  extraction, Piper for the Spanish CPU voice, faster-whisper `small` int8 for
  subtitles and the real Remotion renderer for a 720p MP4. The `gpu` overlay
  adds GPU access and Qwen TTS.

Both modes are covered in CI: the demo happy path runs on every push, the local
mode runs in a nightly/manual job with `ffprobe` assertions on the real audio,
subtitles and video. The installer asks which mode to use, and
`newsroom mode demo|local` switches later.

## Consequences

- A visitor gets a working product immediately; an evaluator can inspect the
  real AI path and its recorded evidence.
- Demo mode cannot silently pretend to be a real AI run: the badge is driven by
  the same mode that selects the adapters.
- Every adapter pair must keep the same port contract, which is enforced by the
  worker-port contract suite.
- Local mode depends on model downloads and machine performance; the nightly
  job is slower than the fast demo suite and is intentionally separate.
