FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    REMOTION_HARDWARE_ACCELERATION=disable \
    REMOTION_GL=swangle \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg python3 python3-venv ca-certificates fonts-dejavu-core \
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
COPY apps/panel/services/approval-editor apps/panel/services/approval-editor

WORKDIR /app/services/renderer
RUN npx remotion browser ensure

# The local renderer is the approval pipeline API with Remotion bundled: the
# panel edits a snapshot there and the same container renders the final 720p
# MP4 on CPU (D10). The legacy CLI stays available as `docker run ... node
# scripts/render-video.js`.
ENV APPROVAL_EDITOR_SERVICE_HOST=0.0.0.0 \
    APPROVAL_EDITOR_SERVICE_PORT=3042 \
    APPROVAL_EDITOR_RENDER_ADAPTER=video-engine \
    APPROVAL_EDITOR_VIDEO_ENGINE_ROOT=/app/services/renderer \
    APPROVAL_EDITOR_VIDEO_ENGINE_PROJECTS_ROOT=/app/runtime/media/renderer \
    APPROVAL_EDITOR_PYTHON_BIN=python3 \
    RENDERER_PROFILE=local \
    REMOTION_HARDWARE_ACCELERATION=disable \
    REMOTION_GL=swangle

WORKDIR /app
RUN mkdir -p /app/apps/panel/services/approval-editor/projects /app/runtime/media/renderer

EXPOSE 3042
HEALTHCHECK --interval=15s --timeout=5s --retries=20 \
    CMD node -e "fetch('http://127.0.0.1:3042/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/panel/services/approval-editor/server.js"]
