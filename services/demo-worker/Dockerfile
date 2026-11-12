FROM node:22-alpine

WORKDIR /app
COPY services/demo-worker/package.json services/demo-worker/package.json
COPY services/demo-worker/src services/demo-worker/src
COPY examples/brand/final-demo.mp4 examples/brand/final-demo.mp4

ENV NODE_ENV=production \
    DEMO_WORKER_PORT=8088 \
    DEMO_VIDEO_PATH=/app/examples/brand/final-demo.mp4

WORKDIR /app/services/demo-worker
EXPOSE 8088
HEALTHCHECK --interval=10s --timeout=3s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:8088/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
