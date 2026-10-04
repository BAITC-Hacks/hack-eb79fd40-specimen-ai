# API Demeu

Актуальная машиночитаемая схема: [`openapi.json`](openapi.json). Сервер отдаёт
тот же документ по `GET /api/openapi`, а страницу для человека по
`GET /api-docs`. Интеграционный smoke требует эквивалентный JSON.

## Границы доступа

| Поверхность | Авторизация |
|---|---|
| `/api/workspace/**`, `/api/referrals/**` | узкая HttpOnly сессия кабинета; роль и организация проверяются сервером |
| `/api/chat/start` | одноразовая ссылка назначенного врача |
| `/api/chat`, `/api/chat/finalize` | узкая HttpOnly cookie конкретной сессии |
| `/api/patient/access` | обмен уникального 30-дневного capability на patient cookie |
| `/api/patient/{id}/package` | cookie с `Path=/api/patient`, привязанная к одному пакету |
| `/api/mis/v1/**` | отдельный Bearer credential организации и scope; cookie кабинета не принимается |
| `/api/analytics/case1` | роли `owner` и `analyst` |
| `/api/healthz`, `/api/openapi`, `/api-docs` | публичные read-only поверхности; deep probe защищён отдельно |

Ресурс вне области назначенного врача возвращает тот же `404 NOT_FOUND`, что и
неизвестный ресурс.

## Основные маршруты

Полный реестр 33 paths и 42 HTTP operations, включая четыре отрицательных
контракта, находится в OpenAPI. Ниже сгруппированы продуктовые маршруты.

### Опрос пациента

- `POST /api/link` — назначенный врач создаёт персональную ссылку.
- `POST /api/chat/start` — начинает RU/KK опрос и создаёт независимый доступ к
  подготовке.
- `POST /api/chat` — принимает ответ; emergency проверяется до следующего
  вопроса.
- `POST /api/chat/finalize` — идемпотентно завершает или повторно читает итог
  без выдачи аналитики пациенту.
- `POST /api/chat/preparation` — защищённый повтор первоначальной записи
  patient grant после временной ошибки хранения.

### Кабинет и направления

- `POST|GET|DELETE /api/workspace/auth` — вход, текущая сессия, выход.
- `GET /api/workspace/intakes[/id]` — опросы в области врача или руководителя.
- `GET|POST /api/referrals`, `GET /api/referrals/{id}` — список, создание и
  детальная карточка.
- `POST /api/referrals/{id}/doctor-assessment` — отдельное аудируемое заключение
  назначенного врача с причиной, revision и immutable triage snapshot.
- `POST /api/referrals/{id}/events` и `/examinations` — операционные факты и
  подтверждённые обследования с optimistic concurrency.
- `GET|POST /api/referrals/{id}/patient-access` — состояние, перевыпуск или
  отзыв patient capability.
- `POST /api/referrals/{id}/patient-reports/confirm` — подтверждение отметки
  пациента назначенным врачом.
- `POST /api/referrals/{id}/registration-snapshot` — immutable снимок
  признаков на момент регистрации.
- `GET /api/referrals/{id}/risk` — исследовательская B3 оценка; она не влияет
  на клиническое решение, срочность или комплектность.
- `GET /api/workspace/aggregates` — серверные агрегаты с подавлением малых
  групп и стабильным release snapshot.
- `POST /api/referrals/{id}/notify` и `GET /patient-memo` — серверная памятка и
  явная доставка врачу.
- `/api/models`, `/api/benchmarks`, `/api/reference/examination-requirements` —
  read-only model, benchmark и catalogue metadata из серверных артефактов.

### Подготовка пациента

- `POST /api/patient/access` — capability exchange на новом устройстве.
- `POST /api/patient/discover` — поиск ранее выданного доступа без расширения
  области.
- `GET /api/patient/{id}/package` — whitelist проекция списка подготовки.
- `POST /api/patient/{id}/package` — самоотметка пациента, отдельная от
  подтверждения врача.
- `GET /api/patient/{id}/package?format=pdf&lang=ru|kk` — PDF той же проекции.

Пакет пациента не содержит transcript, triage, red flags или B3 risk.
`catalogueValidated:false` никогда не превращается в подтверждённую готовность.

### MIS и аналитика

- `POST /api/mis/v1/events/pull` — lease упорядоченных событий организации.
- `POST /api/mis/v1/events/{eventId}/ack` — durable ACK с идемпотентным replay.
- `GET /api/analytics/case1` — семь блоков реального агрегированного артефакта,
  provenance, ограничения и серверные фильтры.

Research risk события требуют одновременно server opt-in и scope
`events:research`. Consumer хранит freshness отдельно для пары
`(referralId, event type)` и по монотонной sequence отклоняет устаревшую
доставку, не смешивая readiness и research streams.

## Ошибки и повторы

Клиенты ветвятся по HTTP status и стабильному `code`, а не по локализованному
тексту. Мутации используют `idempotencyKey`; изменение payload под тем же
ключом даёт `409 IDEMPOTENCY_CONFLICT`. Stale revision даёт
`409 REVISION_CONFLICT` и требует перечитать карточку. Ограничения частоты
возвращают `429` и `Retry-After`.

## Обработка и внешние системы

`DEMEU_PROCESSING_MODE=external_llm|deterministic` выбирается при старте.
Deterministic mode не требует Anthropic key и не отправляет ответы пациента во
внешнюю LLM. Telegram остаётся отдельным каналом доставки; это не означает,
что все данные остаются локально. Finalization smoke разрешает только loopback
Telegram mock и блокирует любой внешний fetch.
