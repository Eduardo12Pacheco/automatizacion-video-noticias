FROM python:3.12-slim

ARG ASR_EXTRAS=asr,fetch

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/app/services/asr-worker \
    NEWSROOM_GPU_LOCK_PATH=/tmp/newsroom-gpu.lock

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY packages/python/newsroom_worker_common /app/packages/python/newsroom_worker_common
COPY packages/python/newsroom_media /app/packages/python/newsroom_media
RUN pip install /app/packages/python/newsroom_worker_common /app/packages/python/newsroom_media

COPY services/asr-worker/pyproject.toml /app/services/asr-worker/pyproject.toml
COPY services/asr-worker/app /app/services/asr-worker/app
COPY services/asr-worker/scripts /app/services/asr-worker/scripts
WORKDIR /app/services/asr-worker
RUN pip install ".[${ASR_EXTRAS}]" \
    && useradd --create-home --uid 10001 newsroom \
    && mkdir -p /app/runtime/media /app/runtime/tts /app/gpu-lock \
    && chown -R newsroom:newsroom /app/runtime /app/gpu-lock /tmp

USER newsroom

EXPOSE 8765
CMD ["/app/services/asr-worker/scripts/run.sh"]
