FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    APPROVAL_EDITOR_SERVICE_HOST=0.0.0.0 \
    APPROVAL_EDITOR_SERVICE_PORT=3042

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The service is CommonJS and depends on the workspace contracts package.
# Mirror the pnpm workspace layout without installing the whole monorepo.
COPY packages/contracts ./packages/contracts
COPY examples/brand ./examples/brand
COPY services/renderer/assets/overlays/outro-primary.mp4 ./services/renderer/assets/overlays/outro-primary.mp4
COPY services/renderer/assets/overlays/outro-secondary.mp4 ./services/renderer/assets/overlays/outro-secondary.mp4
COPY tools/assets/sync-runtime-assets.mjs ./tools/assets/sync-runtime-assets.mjs
COPY services/approval-editor ./services/approval-editor
RUN node tools/assets/sync-runtime-assets.mjs --target=approval-editor
RUN mkdir -p /app/node_modules/@newsroom \
    && ln -s ../../packages/contracts /app/node_modules/@newsroom/contracts \
    && mkdir -p /app/services/approval-editor/projects /app/runtime/media/renderer \
    && chown -R node:node /app/services/approval-editor/projects /app/runtime/media

ENV HOME=/home/node

USER node

EXPOSE 3042
HEALTHCHECK --interval=10s --timeout=3s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:3042/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "services/approval-editor/server.js"]
