FROM node:22-bookworm-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PATH=/opt/venv/bin:$PATH \
    PYTHONPATH=/app/services/subtitles \
    SUBTITLES_REMOTE_WORKSPACE_ROOT=/app/runtime/media/subtitles

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 python3-venv ffmpeg ca-certificates \
        libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
        libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
        libgbm1 libpango-1.0-0 libcairo2 libasound2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY packages/python/newsroom_worker_common /app/packages/python/newsroom_worker_common
COPY services/subtitles /app/services/subtitles

RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --upgrade pip \
    && /opt/venv/bin/pip install /app/packages/python/newsroom_worker_common \
    && /opt/venv/bin/pip install /app/services/subtitles

WORKDIR /app/services/subtitles
RUN npm ci --no-audit --no-fund \
    && useradd --create-home --uid 10001 newsroom \
    && mkdir -p /app/runtime/media \
    && chown -R newsroom:newsroom /app/runtime /app/services/subtitles /home/newsroom
USER newsroom
ENV HOME=/home/newsroom
RUN npx remotion browser ensure

EXPOSE 8092
HEALTHCHECK --interval=10s --timeout=5s --retries=12 \
    CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8092/health', timeout=3)"

CMD ["python3", "scripts/run_remote_api.py"]
