FROM python:3.12-slim

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
RUN pip install /app/packages/python/newsroom_worker_common

COPY services/asr-worker/pyproject.toml /app/services/asr-worker/pyproject.toml
COPY services/asr-worker/app /app/services/asr-worker/app
WORKDIR /app/services/asr-worker
RUN pip install ".[asr,fetch]"

EXPOSE 8765
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8765"]
