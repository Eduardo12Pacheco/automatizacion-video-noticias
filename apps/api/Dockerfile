FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHON_BIN=/opt/newsroom-python/bin/python

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl ffmpeg python3 python3-venv python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/newsroom-python \
    && /opt/newsroom-python/bin/pip install --no-cache-dir trafilatura python-docx lxml_html_clean

RUN corepack enable

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/adapters/package.json packages/adapters/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/data/package.json packages/data/package.json
RUN pnpm install --frozen-lockfile --prod

COPY apps/api apps/api
COPY packages packages
COPY infra/db infra/db
COPY examples examples

# The trafilatura CLI imports the shared URL guard from newsroom_media.
RUN /opt/newsroom-python/bin/pip install --no-cache-dir /app/packages/python/newsroom_media

RUN mkdir -p /app/data/blobs /app/data/documents /app/runtime-logs /app/runtime/media \
    && chown -R node:node /app/data /app/runtime-logs /app/runtime/media

USER node

WORKDIR /app/apps/api
EXPOSE 8099
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:8099/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/gateway.js"]
