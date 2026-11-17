FROM nginxinc/nginx-unprivileged:1.27-alpine

COPY infra/panel/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/panel /usr/share/nginx/html

EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=12 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
