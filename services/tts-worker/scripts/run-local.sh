#!/bin/sh
# Run the public TTS orchestrator and its internal worker in one container.
# The orchestrator speaks the panel contract on 8766; the worker keeps the
# model/synthesis path on loopback so it is never published on the network.
set -eu

uvicorn voice_tts_service.api.worker_app:app \
  --host 127.0.0.1 \
  --port "${TTS_WORKER_INTERNAL_PORT:-8767}" &
worker_pid=$!

cleanup() {
  kill "$worker_pid" 2>/dev/null || true
}
trap cleanup INT TERM

uvicorn voice_tts_service.api.orchestrator_app:app \
  --host "${TTS_WORKER_HOST:-0.0.0.0}" \
  --port "${TTS_WORKER_PORT:-8766}"
