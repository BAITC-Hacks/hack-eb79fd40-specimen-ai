#!/bin/sh

set -eu

TARGET_PUBLIC_IP="109.123.248.16"
DEFAULT_DEMEU_DOMAIN="$TARGET_PUBLIC_IP"
if [ "${DEMEU_DOMAIN+x}" != x ]; then
  DEMEU_DOMAIN="$DEFAULT_DEMEU_DOMAIN"
fi
if [ "${APP_PORT+x}" != x ]; then
  APP_PORT="3100"
fi
if [ "${TLS_BRANCH+x}" != x ]; then
  TLS_BRANCH="branch-b-caddy"
fi

invalid_domain() {
  printf '%s\n' \
    "Invalid DEMEU_DOMAIN: expected 109.123.248.16 or a normalized lowercase ASCII DNS FQDN" >&2
  exit 64
}

is_target_ip=0
if [ "$DEMEU_DOMAIN" = "$TARGET_PUBLIC_IP" ]; then
  is_target_ip=1
else
  case "$DEMEU_DOMAIN" in
    ''|localhost|.*|*.|*..*|*[!a-z0-9.-]*)
      invalid_domain
      ;;
    *.*)
      ;;
    *)
      invalid_domain
      ;;
  esac

  [ "${#DEMEU_DOMAIN}" -le 253 ] || invalid_domain

  old_ifs=$IFS
  IFS=.
  label_count=0
  final_label=
  for label in $DEMEU_DOMAIN; do
    label_count=$((label_count + 1))
    final_label=$label
    case "$label" in
      ''|-*|*-|*[!a-z0-9-]*|xn--*)
        invalid_domain
        ;;
    esac
    [ "${#label}" -le 63 ] || invalid_domain
  done
  IFS=$old_ifs
  [ "$label_count" -ge 2 ] || invalid_domain

  case "$final_label" in
    *[!0-9]*) ;;
    *) invalid_domain ;;
  esac
  case "$final_label" in
    0x*)
      final_hex=${final_label#0x}
      case "$final_hex" in
        *[!0-9a-f]*) ;;
        *) invalid_domain ;;
      esac
      ;;
  esac
fi

if [ "$is_target_ip" -eq 1 ] && [ "$TLS_BRANCH" != "branch-b-caddy" ]; then
  printf '%s\n' \
    "Invalid TLS_BRANCH: 109.123.248.16 requires branch-b-caddy" >&2
  exit 64
fi

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

export DEMEU_DOMAIN APP_PORT TLS_BRANCH

command_name="${1:-preflight}"
if [ "$is_target_ip" -eq 1 ]; then
  case "$command_name" in
    host-app-up|render-nginx|render-caddy)
      printf '%s\n' \
        "Invalid TLS command: 109.123.248.16 is supported only by branch B Caddy" >&2
      exit 64
      ;;
  esac
fi
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
    if [ "$is_target_ip" -eq 1 ]; then
      config=/etc/caddy/Caddyfile.ip
    else
      config=/etc/caddy/Caddyfile.fqdn
    fi
    exec caddy run --config "$config" --adapter caddyfile
    ;;
  *)
    printf '%s\n' \
      "Usage: deploy/tls.sh {preflight|branch-b-config|branch-b-up|host-app-up|render-nginx|render-caddy|caddy-run}" >&2
    exit 64
    ;;
esac
