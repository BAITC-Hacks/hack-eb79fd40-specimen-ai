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
- LR-модель интегрирована в `analyze()`, parity Python↔TypeScript зелёный на
  150/150 примерах. В живом сценарии модель корректно воздержалась с
  `low_confidence`, и результат безопасно перешёл в `llm_fallback`.
- Read-only SSH-разведка VPS принята: Docker/Compose доступны, 80/443/3100
  были свободны, выбрана `branch-b-caddy`. Повторный preflight и dry-run rsync
  прошли без изменения VPS.
- Eval и публичные числа зафиксированы в `eval/report.json`; routing/urgency
  остаются `UNVALIDATED`, пока `data/pathology_map.json` имеет
  `validated:false`.

## 3. Что осталось до release

1. Получить явно разрешённый commit/push принятого worktree. До этого deploy
   обязан останавливаться: старый SHA не описывает текущие байты.
2. Запустить branch B deploy из `deploy/DEPLOY.md`, затем подтвердить публичный
   сертификат и L1 без обхода TLS-проверки.
3. После отдельного разрешения стоимости запустить L2: три production-сценария.
   Локальный live-прогон одного сценария не заменяет этот шаг.
4. Отдельно проверить сводку глазами в Telegram; HTTP 200 Bot API не является
   read receipt.
5. Ардан проверяет продуктовый UI, деку, демо-видео и сдачу. Врачебная
   валидация таблицы маршрутизации остаётся отдельной задачей.

## Стек

Next.js 15.5 (App Router) · React 19 · TypeScript · Anthropic SDK · Docker.
Python используется только офлайн в `scripts/`. Живой прогон против API
выполнен локально для одного срочного сценария; публичный production-прогон
ещё не выполнен.
