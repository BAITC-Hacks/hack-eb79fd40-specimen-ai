# Хендофф для Алмаза — Demeu (GovTech Camp)

Дедлайн этапа: **17.07.2026, 23:59 GMT+5** (Google Forms).
Продукт: AI-триаж и первичный сбор анамнеза для госполиклиник. **Не диагноз** — гипотеза + приоритет + маршрутизация, решает врач.

Полный контекст — в `README.md`. Ниже — что от тебя нужно.

## 1. Запустить и проверить (первым делом)

```bash
npm install
cp .env.example .env      # впиши ANTHROPIC_API_KEY
npm run dev               # http://localhost:3000
```

Проверка без сети: `npm run lint`, `npx tsc --noEmit`, `npm test`,
`npm run build`, `ruff check .` и
`npm run eval -- --allow-unvalidated --check`.

## 2. Что уже подтверждено

- Собственный Telegram-адаптер и PDF работают. Локальный срочный сценарий
  дошёл через канонические API и два запроса Anthropic до `emergency`,
  `chest_pain`, PDF и HTTP 200 от Telegram Bot API для текста и документа.
  Это API acceptance, а не подтверждение прочтения человеком.
- Для рассылки нескольким врачам задайте `TELEGRAM_DOCTOR_CHAT_IDS` списком
  числовых `chat_id` через запятую. Старый `TELEGRAM_DOCTOR_CHAT_ID`
  поддерживается как один получатель. Ошибка одного адресата не останавливает
  остальных; статус доставки остаётся агрегатным на уровне сессии.
- LR-модель интегрирована в `analyze()`, parity Python↔TypeScript зелёный на
  150/150 примерах. В живом сценарии модель корректно воздержалась с
  `low_confidence`, и результат безопасно перешёл в `llm_fallback`.
- Read-only SSH-разведка VPS принята: Docker/Compose доступны, 80/443/3100
  были свободны, выбрана `branch-b-caddy`. Exact-SHA deploy, публичный
  сертификат и независимый L1 smoke приняты; один production-сценарий 1
  выполнен без повторов.
- Eval и публичные числа зафиксированы в `eval/report.json`; routing/urgency
  остаются `UNVALIDATED`, пока `data/pathology_map.json` имеет
  `validated:false`.

## 3. Текущий release

1. Канонический репозиторий организаторов —
   `BAITC-Hacks/hack-eb79fd40-specimen-ai`, ветка `main`; канонический origin —
   `https://specimen-ai.govtech-kz.com`.
2. После отдельного разрешения стоимости запустить L2: три production-сценария.
   Локальный live-прогон одного сценария не заменяет этот шаг.
3. Отдельно проверить сводку глазами в Telegram; HTTP 200 Bot API не является
   read receipt.
4. Ардан проверяет продуктовый UI, деку, демо-видео и сдачу. Врачебная
   валидация таблицы маршрутизации остаётся отдельной задачей.
5. Прежний сервис `https://84.247.161.211` не выключать до приёмки нового
   origin. Текущая топология — shared host Caddy → loopback `8019`; подробности
   в `docs/production-astana-hub.md`.

## Стек

Next.js 15.5 (App Router) · React 19 · TypeScript · Anthropic SDK · Docker.
Python используется только офлайн в `scripts/`. Живой прогон против API
выполнен для одного срочного сценария на прежнем production. Проверка нового
origin входит в release acceptance; L2 остаётся за отдельным разрешением.
