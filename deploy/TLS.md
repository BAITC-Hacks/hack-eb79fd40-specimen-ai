# TLS / reverse proxy: взаимоисключающие ветки

Запуск приложения, два режима доставки кода и автоматический возврат на последний зелёный образ
описаны в `deploy/DEPLOY.md`.

Read-only разведка VPS принята: на момент двух проверок порты 80, 443 и 3100
были свободны, Docker/Compose доступны, поэтому для Demeu выбрана ветка B с
отдельным Caddy. Выдача публичного сертификата, доступность 80/443 через
внешний firewall и публичный HTTPS/smoke ещё **не проверены**. Перед активацией
нужно повторить preflight, потому что состояние listeners может измениться.

Один параметр управляет доменом и `APP_BASE_URL` во всех конфигурациях:

```dotenv
DEMEU_DOMAIN=109-123-248-16.sslip.io
```

Если Let's Encrypt не выдаст сертификат для общего `sslip.io`, единственная правка:

```dotenv
DEMEU_DOMAIN=109-123-248-16.nip.io
```

Rate limit Let's Encrypt и доступность magic-DNS в момент деплоя проверяются только на VPS.

`deploy/tls.sh` — обязательная fail-closed точка входа для обеих веток. Она принимает только два
указанных выше bare hostname, проверяет `APP_PORT` и прекращает работу до compose/render при схеме,
пути, порте в hostname, пробелах или любом другом значении. Не запускайте показанные внутри overlay
команды напрямую. Контейнер Caddy повторяет эту проверку при каждом старте.

## Ветка B: порты 80/443 свободны

Эта ветка использует собственный Caddy. Overlay удаляет даже loopback-публикацию приложения:
на хосте публикуются только TCP 80/443, а Caddy обращается к `app:3000` по compose-сети.
Тег `!reset` требует Docker Compose 2.24.4 или новее; обязательный `compose config` ниже прекращает
работу до старта контейнеров, если установлен старый Compose.

```bash
docker compose version
export DEMEU_DOMAIN="${DEMEU_DOMAIN-109-123-248-16.sslip.io}"
./deploy/tls.sh preflight
./deploy/tls.sh branch-b-config
./deploy/tls.sh branch-b-up
ufw allow 80/tcp
ufw allow 443/tcp
ufw status
curl -fsS "https://${DEMEU_DOMAIN}/api/healthz"
```

HTTP-01 требует доступного извне порта 80. Данные ACME и конфигурация Caddy сохраняются в named volumes
`caddy_data` и `caddy_config`.

## Ветка A: 80/443 уже обслуживает host nginx

Собственный Caddy overlay не запускается. Приложение стартует только базовым compose и остаётся на
`127.0.0.1:${APP_PORT:-3100}`:

```bash
set -a
. ./.env
set +a
export DEMEU_DOMAIN="${DEMEU_DOMAIN-109-123-248-16.sslip.io}"
export APP_PORT="${APP_PORT-3100}"
./deploy/tls.sh preflight
./deploy/tls.sh host-app-up
./deploy/tls.sh render-nginx /tmp/demeu.nginx.conf
docker run --rm \
  -v /tmp/demeu.nginx.conf:/etc/nginx/conf.d/default.conf:ro \
  nginx:1.27-alpine nginx -t
sudo install -m 0644 /tmp/demeu.nginx.conf /etc/nginx/sites-available/demeu
sudo ln -sfn /etc/nginx/sites-available/demeu /etc/nginx/sites-enabled/demeu
sudo nginx -t
sudo systemctl reload nginx
```

После зелёного HTTP и DNS пользователь задаёт контактный email и вручную запускает certbot:

```bash
read -r -p 'Certbot contact email: ' CERTBOT_EMAIL
case "${CERTBOT_EMAIL}" in *@*.*) ;; *) echo 'Некорректный email' >&2; exit 1;; esac
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d "${DEMEU_DOMAIN}" --agree-tos \
  --email "${CERTBOT_EMAIL}" --non-interactive --redirect
curl -fsS "https://${DEMEU_DOMAIN}/api/healthz"
```

`proxy_read_timeout` и `proxy_send_timeout` равны 120 секундам для долгих LLM-ходов.

## Ветка A: 80/443 уже обслуживает host Caddy

Здесь также запускается app-only compose без Caddy. Шаблон рендерится в отдельный импорт, не заменяя
существующий конфиг других сервисов:

```bash
set -a
. ./.env
set +a
export DEMEU_DOMAIN="${DEMEU_DOMAIN-109-123-248-16.sslip.io}"
export APP_PORT="${APP_PORT-3100}"
./deploy/tls.sh preflight
./deploy/tls.sh host-app-up
./deploy/tls.sh render-caddy /tmp/demeu.Caddyfile
docker run --rm \
  -v /tmp/demeu.Caddyfile:/etc/caddy/Caddyfile:ro \
  caddy:2.10.2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo install -m 0644 /tmp/demeu.Caddyfile /etc/caddy/demeu.Caddyfile
grep -qxF 'import /etc/caddy/demeu.Caddyfile' /etc/caddy/Caddyfile \
  || printf '\nimport /etc/caddy/demeu.Caddyfile\n' | sudo tee -a /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
curl -fsS "https://${DEMEU_DOMAIN}/api/healthz"
```

## Что остаётся подтвердить с VPS

- неизменность принятой ветки B повторным preflight перед активацией;
- доступность 80/443 через внешний firewall;
- DNS в момент запуска;
- получение публичного сертификата без обхода проверки TLS;
- `200` от публичного `/api/healthz`.
