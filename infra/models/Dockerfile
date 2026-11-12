FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN pip install --no-cache-dir "huggingface_hub>=0.26,<1"

WORKDIR /app
COPY infra/models/model-init.py /app/infra/models/model-init.py
COPY infra/models/model-init.sh /app/infra/models/model-init.sh

ENTRYPOINT ["/app/infra/models/model-init.sh"]
