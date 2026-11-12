FROM node:22-bookworm-slim

ENV NODE_ENV=production \
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

WORKDIR /app/services/renderer
COPY services/renderer/package.json services/renderer/package-lock.json ./
RUN npm ci --omit=dev
COPY services/renderer ./
RUN npx remotion browser ensure

ENTRYPOINT ["node", "scripts/render-video.js"]
