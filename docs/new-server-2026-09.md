# Новый сервер — сентябрь 2026

Пользователь 14.09.2026 назначил новый VPS `84.247.161.211` и предоставил доступ для установки с нуля. Это явное операционное дополнение к историческому SPINE: прежний VPS `109.123.248.16` не используется в этом запуске. Нельзя выбирать старый адрес из дефолтов скриптов.

Целевой origin: `https://84-247-161-211.sslip.io`. Состояние фактической проверки фиксируется отдельным отчётом после запуска; этот документ описывает выбранную конфигурацию, а не доказывает доступность.

## Размещение

- `/opt/demeu/app`: чистый Git checkout конкретного опубликованного коммита.
- `/opt/demeu/app/.env`: приватная runtime-конфигурация, режим 0600; никогда не git и не Docker build context.
- `/var/lib/demeu`: постоянное состояние, UID/GID 1001:1001, режим 0700.
- `/etc/demeu/accounts.json`: scrypt-хеши учётных записей, UID/GID 1001:1001, режим 0600, read-only mount.
- `/etc/demeu/access-handoff.txt`: временная приватная передача новых паролей оператору, режим 0600. После сохранения в менеджере паролей оператор удаляет файл.

Один Node-процесс, Caddy в Compose, только веб-порты 80/443 опубликованы. Контейнер приложения не публикует 3000/3100. TLS storage остаётся в Docker volumes. Исходные демо-снимки с локальной машины не переносятся. Docker установлен из [официального apt-репозитория](https://docs.docker.com/engine/install/ubuntu/).

В `.env` явно задаются `DEMEU_DOMAIN=84-247-161-211.sslip.io`, `APP_BASE_URL=https://84-247-161-211.sslip.io`, `TLS_BRANCH=branch-b-caddy`, `VPS_RECON_CONFIRMED=yes`, `APP_PORT=3100`, `DEMEU_HOST_DATA_DIR=/var/lib/demeu`, `DEMEU_HOST_ACCOUNTS_FILE=/etc/demeu/accounts.json`, независимый `DEMEU_AUTH_SECRET` и интеграционные реквизиты. Не печатать `docker compose config` без `--quiet`: он раскрывает секреты.

## Сборка и запуск

Выполнять из `/opt/demeu/app` после проверки приватных файлов:

```bash
export COMMIT_SHA="$(git rev-parse HEAD)"
docker compose -f docker-compose.yml -f deploy/compose.caddy.yml -f deploy/compose.workspace.yml config --quiet
docker compose -f docker-compose.yml -f deploy/compose.caddy.yml -f deploy/compose.workspace.yml build app
docker compose -f docker-compose.yml -f deploy/compose.caddy.yml -f deploy/compose.workspace.yml up -d
docker compose -f docker-compose.yml -f deploy/compose.caddy.yml -f deploy/compose.workspace.yml ps
curl --fail --silent --show-error https://84-247-161-211.sslip.io/api/healthz
```

Проверить совпадение `commit` с `git rev-parse HEAD`, HTTPS без `-k`, вход и область роли, отсутствие публичного порта приложения. `llm_ok` в обычном health — только наличие ключа; живой ответ требует отдельной пробы. Получатель Telegram задаётся в конкретной учётной записи, глобальный chat ID не является обходом принадлежности.

**Важно:** исторические `deploy/deploy.sh`, `rollback.sh` и `tls.sh branch-b-up` не подключают workspace overlay. Не запускать их для этого кабинета без доработки: при пересоздании потеряются mounts/auth configuration. Использовать полную тройку Compose-файлов выше при каждом запуске, рестарте и обновлении.

## Доставка обновления без ключа GitHub на VPS

После commit/push проверенного релиза локально создать bundle выбранной ветки:

```bash
git bundle create /tmp/demeu-release.bundle codex/september-foundation
git bundle verify /tmp/demeu-release.bundle
scp /tmp/demeu-release.bundle root@84.247.161.211:/opt/demeu/release.bundle
```

Для первого запуска (только если `/opt/demeu/app` ещё не существует):

```bash
git clone --branch codex/september-foundation /opt/demeu/release.bundle /opt/demeu/app
```

Для обновления существующего checkout:

```bash
cd /opt/demeu/app
test -z "$(git status --porcelain)"
git fetch /opt/demeu/release.bundle codex/september-foundation
git merge --ff-only FETCH_HEAD
```

После этого повторить полную сборку/запуск выше. Bundle содержит только Git-объекты, не `.env`, локальные snapshots, сырые датасеты или node_modules. На VPS не требуется сохранять личный GitHub-токен или SSH-ключ пользователя.

## Backup и восстановление

Перед обновлением остановить единственный writer полной Compose-командой `stop app`. Сохранить под режимом 0700 каталог с копиями `/var/lib/demeu`, `/etc/demeu/accounts.json`, приватной `.env`, SHA и образом текущего приложения. Состояние включает `sessions.json`, `referrals.json`, `deliveries.json` при их наличии. Затем запустить `start app`. Не выполнять `down -v` и не удалять `/var/lib/demeu`.

Восстановление проверять в отдельном приватном каталоге и без внешней отправки. Образ и схема данных должны быть совместимы. При ошибке обновления не направлять старую версию, не понимающую новую схему, на рабочие файлы. Переход на прошлый образ и проверку health выполнять с теми же mounts и proxy overlay.

Хранение реальных персональных данных, клиническая валидация и нормативные справочники остаются отдельными согласованиями; наличие HTTPS не означает готовность персонального пилота.
