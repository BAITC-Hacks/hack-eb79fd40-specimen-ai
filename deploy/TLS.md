# TLS / reverse proxy: взаимоисключающие ветки

Запуск приложения, два режима доставки кода и автоматический возврат на последний зелёный образ
описаны в `deploy/DEPLOY.md`.

Read-only разведка VPS принята: на момент двух проверок порты 80, 443 и 3100
были свободны, Docker/Compose доступны, поэтому для Demeu выбрана ветка B с
отдельным pinned Caddy `2.10.2-alpine`. Текущий magic-DNS production получил
публичный сертификат и прошёл независимый L1 smoke без обхода TLS. Новый
bare-IP origin подготовлен offline, но live-сертификат и L1 для него ещё
**не проверены**.

Один параметр управляет доменом и `APP_BASE_URL` во всех конфигурациях:

```dotenv
DEMEU_DOMAIN=109.123.248.16
APP_BASE_URL=https://109.123.248.16
```

Прежний magic-DNS остаётся rollback origin и автоматически обслуживается тем
же backend во время IP rollout:

```dotenv
DEMEU_DOMAIN=109-123-248-16.sslip.io
APP_BASE_URL=https://109-123-248-16.sslip.io
```

Без отдельного изменения поддерживается и нормализованный FQDN, например:

```dotenv
DEMEU_DOMAIN=demo.example.kz
APP_BASE_URL=https://demo.example.kz
```

`deploy/tls.sh` — обязательная fail-closed точка входа для обеих веток. Она принимает только
точный публичный IPv4 `109.123.248.16` либо нормализованный lowercase ASCII DNS FQDN. Любой другой
IPv4, private/loopback/link-local адрес, IPv6, схема, путь, порт, wildcard, `localhost`, пробел,
shell-метасимвол, Unicode и `xn--`-метка отвергаются до Docker. IP разрешён только с
`TLS_BRANCH=branch-b-caddy`; host-proxy ветки A остаются FQDN-only.
`APP_BASE_URL` в deploy/rollback обязан быть точным `https://${DEMEU_DOMAIN}`. Не запускайте
показанные внутри overlay команды напрямую. Контейнер Caddy повторяет проверку при каждом старте.

Vercel для текущего MVP не рекомендуется: сессии хранятся в памяти процесса, а serverless
instances/cold starts разрывают цепочку link → start → chat → finalize; долгий structured-вызов
также превышает безопасный бюджет тонкого proxy. Канонический runtime остаётся на существующем
VPS+Caddy.

## Ветка B: порты 80/443 свободны

Эта ветка использует собственный Caddy. Overlay удаляет даже loopback-публикацию приложения:
на хосте публикуются только TCP 80/443, а Caddy обращается к `app:3000` по compose-сети.
Тег `!reset` требует Docker Compose 2.24.4 или новее; обязательный `compose config` ниже прекращает
работу до старта контейнеров, если установлен старый Compose.

```bash
docker compose version
export DEMEU_DOMAIN="${DEMEU_DOMAIN-109.123.248.16}"
export TLS_BRANCH=branch-b-caddy
./deploy/tls.sh preflight
./deploy/tls.sh branch-b-config
./deploy/tls.sh branch-b-up
ufw allow 80/tcp
ufw allow 443/tcp
ufw status
curl -fsS "https://${DEMEU_DOMAIN}/api/healthz"
```

HTTP-01 требует доступного извне порта 80. Данные ACME и конфигурация Caddy сохраняются в named volumes
`caddy_data` и `caddy_config`. Для IP Caddy запрашивает профиль ACME `shortlived`, явно отключает
TLS-ALPN challenge и оставляет HTTP-01 включённым. Срок такого сертификата около 160 часов;
нативный Caddy использует ACME Renewal Information и автоматически обновляет его. Отдельный cron,
Certbot, новая инфраструктура или upgrade Caddy не нужны. Никогда не выполняйте `docker compose down -v`:
это удалит ACME state и сертификаты.

## Ветка A: 80/443 уже обслуживает host nginx

Собственный Caddy overlay не запускается. Приложение стартует только базовым compose и остаётся на
`127.0.0.1:${APP_PORT:-3100}`:

```bash
set -a
. ./.env
set +a
export DEMEU_DOMAIN="${DEMEU_DOMAIN-demo.example.kz}"
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

Получение публичного сертификата в этой ветке остаётся ответственностью уже установленного host
nginx и его существующего ACME-процесса; данный change не устанавливает Certbot и не меняет host.

`proxy_read_timeout` и `proxy_send_timeout` равны 120 секундам для долгих LLM-ходов.

## Ветка A: 80/443 уже обслуживает host Caddy

Здесь также запускается app-only compose без Caddy. Шаблон рендерится в отдельный импорт, не заменяя
существующий конфиг других сервисов:

```bash
set -a
. ./.env
set +a
export DEMEU_DOMAIN="${DEMEU_DOMAIN-demo.example.kz}"
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

- повторный read-only preflight listeners и доступность TCP 80/443;
- выдачу short-lived сертификата с SAN `109.123.248.16` через HTTP-01;
- `curl` без `-k` → `200` на `https://109.123.248.16/api/healthz` и HTTP→HTTPS redirect;
- L1 через точный IP origin и сохранение sslip rollback-alias.

Переключение домена требует recreate приложения, потому что меняется server-only `APP_BASE_URL`.
`SessionStore` in-memory: активные ссылки и опросы при recreate теряются. Переключайте в окно без
активных пациентов и после старта сгенерируйте новые ссылки.
