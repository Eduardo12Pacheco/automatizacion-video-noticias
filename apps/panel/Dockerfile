FROM nginxinc/nginx-unprivileged:1.27-alpine

COPY infra/panel/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/panel /usr/share/nginx/html

# Runtime demo media is generated from the canonical examples/brand set.
COPY examples/brand/logo-demo.webm /usr/share/nginx/html/assets/logo-primary.webm
COPY examples/brand/logo-demo.webm /usr/share/nginx/html/assets/logo-secondary.webm
COPY examples/brand/logo-demo-green.mp4 /usr/share/nginx/html/assets/logo-green.mp4
COPY examples/brand/logo-demo-green.mp4 /usr/share/nginx/html/assets/logo-clean.mp4
COPY examples/brand/logo-demo.png /usr/share/nginx/html/assets/logo-final.png
COPY examples/brand/particle-1.webm /usr/share/nginx/html/assets/particle-1.webm
COPY examples/brand/particle-2.webm /usr/share/nginx/html/assets/particle-2.webm
COPY examples/brand/particle-3.webm /usr/share/nginx/html/assets/particle-3.webm
COPY examples/brand/particle-4.webm /usr/share/nginx/html/assets/particle-4.webm
COPY examples/brand/overlay-1.webm /usr/share/nginx/html/assets/overlay-layer-01.webm
COPY examples/brand/overlay-2.webm /usr/share/nginx/html/assets/overlay-layer-02.webm
COPY examples/brand/transition-1.mp4 /usr/share/nginx/html/assets/boundary-transitions/transition-1.mp4
COPY examples/brand/transition-2.mp4 /usr/share/nginx/html/assets/boundary-transitions/transition-2.mp4
COPY examples/brand/transition-3.mp4 /usr/share/nginx/html/assets/boundary-transitions/transition-3.mp4
COPY examples/brand/sfx/sting.wav /usr/share/nginx/html/assets/sfx/sting.wav
COPY examples/brand/sfx/whip.wav /usr/share/nginx/html/assets/sfx/whip.wav
COPY examples/brand/sfx/whoosh.wav /usr/share/nginx/html/assets/sfx/whoosh.wav
COPY examples/brand/sfx/whip.wav /usr/share/nginx/html/assets/sfx/sound-demo.wav
COPY examples/brand/fonts/Demo-Display.woff2 /usr/share/nginx/html/assets/fonts/display/Demo-Display.woff2

EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=12 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
