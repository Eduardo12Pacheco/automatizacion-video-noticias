# One-shot tools image. It stays root because Docker creates the model
# named volumes owned by root and this process populates them before the
# stack starts; every long-running service drops to a non-root user.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN pip install --no-cache-dir "huggingface_hub>=0.26,<1"

WORKDIR /app
COPY infra/models/model-init.py /app/infra/models/model-init.py
COPY infra/models/model-manifest.json /app/infra/models/model-manifest.json
COPY infra/models/model-init.sh /app/infra/models/model-init.sh

ENTRYPOINT ["/app/infra/models/model-init.sh"]
