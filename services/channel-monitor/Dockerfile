FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/app \
    CHANNEL_MONITOR_DB_PATH=/app/runtime/monitor.sqlite3

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY services/channel-monitor/pyproject.toml ./
COPY services/channel-monitor/app ./app
COPY services/channel-monitor/config ./config
RUN pip install . && mkdir -p runtime

EXPOSE 8790
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8790"]
