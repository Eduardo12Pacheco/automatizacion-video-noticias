FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    REMOTION_HARDWARE_ACCELERATION=disable \
    REMOTION_GL=swangle \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg python3 ca-certificates fonts-dejavu-core \
        libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
        libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
        libgbm1 libpango-1.0-0 libcairo2 libasound2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/panel/package.json apps/panel/package.json
COPY packages/adapters/package.json packages/adapters/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/data/package.json packages/data/package.json
COPY services/demo-worker/package.json services/demo-worker/package.json
COPY services/renderer/package.json services/renderer/package.json
COPY services/subtitles/package.json services/subtitles/package.json
RUN corepack enable && pnpm install --frozen-lockfile --prod --filter @newsroom/renderer...

COPY packages/contracts packages/contracts
COPY services/renderer services/renderer

WORKDIR /app/services/renderer
RUN npx remotion browser ensure

ENTRYPOINT ["node", "scripts/render-video.js"]
