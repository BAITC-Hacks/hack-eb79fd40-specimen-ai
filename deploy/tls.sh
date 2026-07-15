#!/bin/sh

set -eu

DEFAULT_DEMEU_DOMAIN="109-123-248-16.sslip.io"
if [ "${DEMEU_DOMAIN+x}" != x ]; then
  DEMEU_DOMAIN="$DEFAULT_DEMEU_DOMAIN"
fi
if [ "${APP_PORT+x}" != x ]; then
  APP_PORT="3100"
fi

case "$DEMEU_DOMAIN" in
  109-123-248-16.sslip.io|109-123-248-16.nip.io)
    ;;
  *)
    printf '%s\n' \
      "Invalid DEMEU_DOMAIN: expected 109-123-248-16.sslip.io or 109-123-248-16.nip.io" >&2
    exit 64
    ;;
esac

case "$APP_PORT" in
  ''|0|0*|*[!0-9]*)
    printf '%s\n' "Invalid APP_PORT: expected an integer from 1 to 65535" >&2
    exit 64
    ;;
esac

if [ "${#APP_PORT}" -gt 5 ]; then
  printf '%s\n' "Invalid APP_PORT: expected an integer from 1 to 65535" >&2
  exit 64
fi

if [ "$APP_PORT" -lt 1 ] || [ "$APP_PORT" -gt 65535 ]; then
  printf '%s\n' "Invalid APP_PORT: expected an integer from 1 to 65535" >&2
  exit 64
fi

export DEMEU_DOMAIN APP_PORT

command_name="${1:-preflight}"
case "$command_name" in
  preflight)
    printf 'TLS preflight OK: domain=%s app_port=%s\n' "$DEMEU_DOMAIN" "$APP_PORT"
    ;;
  branch-b-config)
    exec docker compose -f docker-compose.yml -f deploy/compose.caddy.yml config --quiet
    ;;
  branch-b-up)
    exec docker compose -f docker-compose.yml -f deploy/compose.caddy.yml up -d --build
    ;;
  host-app-up)
    exec docker compose -f docker-compose.yml -f deploy/compose.host-proxy.yml up -d --build app
    ;;
  render-nginx)
    output="${2:-/tmp/demeu.nginx.conf}"
    envsubst '${DEMEU_DOMAIN} ${APP_PORT}' \
      < deploy/nginx/demeu.conf.template > "$output"
    ;;
  render-caddy)
    output="${2:-/tmp/demeu.Caddyfile}"
    envsubst '${DEMEU_DOMAIN} ${APP_PORT}' \
      < deploy/Caddyfile.host.template > "$output"
    ;;
  caddy-run)
    exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
    ;;
  *)
    printf '%s\n' \
      "Usage: deploy/tls.sh {preflight|branch-b-config|branch-b-up|host-app-up|render-nginx|render-caddy|caddy-run}" >&2
    exit 64
    ;;
esac
