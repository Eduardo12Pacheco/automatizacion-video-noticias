ARG BASE_IMAGE=python:3.12-slim
FROM ${BASE_IMAGE}

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/app/services/tts-worker \
    NEWSROOM_GPU_LOCK_PATH=/tmp/newsroom-gpu.lock \
    TTS_WORKER_RUNTIME_DIR=/app/services/tts-worker/runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY packages/python/newsroom_worker_common /app/packages/python/newsroom_worker_common
RUN pip install /app/packages/python/newsroom_worker_common

COPY services/tts-worker/pyproject.toml /app/services/tts-worker/pyproject.toml
COPY services/tts-worker/voice_tts_service /app/services/tts-worker/voice_tts_service
COPY services/tts-worker/src /app/services/tts-worker/src
COPY services/tts-worker/config /app/services/tts-worker/config
COPY services/tts-worker/refs /app/services/tts-worker/refs
WORKDIR /app/services/tts-worker

ARG TTS_EXTRAS=piper
RUN pip install ".[${TTS_EXTRAS}]" \
    && mkdir -p runtime refs \
    && touch refs/voz.wav refs/voz.txt

EXPOSE 8766
CMD ["uvicorn", "voice_tts_service.api.worker_app:app", "--host", "0.0.0.0", "--port", "8766"]
