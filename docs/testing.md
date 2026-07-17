# Тестирование

> Практическая матрица проверок Demeu: что входит в default Vitest, какие гейты запускаются отдельно, где проходит граница сети и как разбирать известный PDF timeout.

**Обновлено:** 2026-07-17

**Базовый коммит:** `19aa755`

**Канон контрактов:** SPINE v2 и исполняемые конфиги базового коммита

**Evidence по прогонам:** [status.md](./status.md)

## Быстрый обязательный проход

Для обычного изменения TypeScript/Next.js:

```bash
npm run lint
npx tsc --noEmit
npm test
```

Для Python-кода в `scripts/` дополнительно:

```bash
ruff check .
.venv/bin/python -m unittest discover -s scripts/tests
```

Команды выше не должны обращаться к внешнему model provider. Наличие `.env` для них не требуется и не проверяется содержимым документации.

## Инвентарь на baseline

| Набор | Объём | Входит в `npm test` |
|---|---:|---|
| Vitest `tests/**/*.test.{ts,tsx}` | 55 файлов | да |
| Python `scripts/tests/test_*.py` | 10 файлов, 46 test methods | нет |
| Standalone health integration | 1 `.mjs` runner | нет |
| Live LLM smoke | отдельный config/script | нет |
| Live analytics/scenario scripts | отдельные scripts | нет |
| Deployment shell smoke | отдельные runbooks | нет |

**55 — число файлов, не test cases.** Количество cases зависит от parametrized fixtures и версии baseline; не следует писать «55 тестов».

[`vitest.config.ts`](../vitest.config.ts) включает только `tests/**/*.test.{ts,tsx}`, использует Node environment и `passWithNoTests=true`. Поэтому успешный `npm test` не означает, что Python, build, standalone Docker или live-проверки запускались.

В репозитории нет `.github` workflows. Автоматического CI-гейта нет: результаты локальных команд должны быть явно приложены к handoff/review.

## Слои проверки

| Слой | Что проверяет | Команда | Сеть / provider |
|---|---|---|---|
| Lint | ESLint, Next/React правила | `npm run lint` | нет |
| TypeScript | типы без emit | `npx tsc --noEmit` | нет |
| Default Vitest | unit, contracts, model parity, offline mock E2E, shell/config guards | `npm test` | нет |
| Production build | standalone bundle и статические imports | `npm run build` | нет provider-вызова |
| Python lint | offline scripts | `ruff check .` | нет |
| Python tests | feature/export/render/train contracts | `.venv/bin/python -m unittest discover -s scripts/tests` | нет |
| Eval guard | hashes, metrics, statuses, invariants | `npm run eval -- --allow-unvalidated --check` | нет |
| Standalone health | готовый Next bundle в `node:24-alpine`, `--network none` | `npm run test:healthz:standalone` | сеть отключена |
| Live suites | реальный provider и/или production | только отдельная явная авторизация | да |

`npm run test:healthz:standalone` сначала делает build, затем использует уже имеющийся локальный Docker image с `--pull never`; отсутствие image — инфраструктурная предпосылка, а не повод разрешать сетевой pull молча.

## Что покрывает default Vitest

### Контракты и золотые инварианты

Единый checker применяется к unit/golden/eval-представлениям. Критические свойства:

1. Emergency-красный флаг всегда повышает urgency до `emergency`, независимо от модели.
2. Quote evidence является дословной подстрокой конкретного user message; derived evidence имеет index `-1`.
3. `TriageResult` контрактно полон; `model` существует только если scorer реально считался. При abstain объект сохраняется, а чувствительные к интерпретации списки очищаются; при `rules_only` модели нет.
4. Disclaimer непустой и оставляет решение врачу.

Дополнительные инварианты проверяют конечность вероятностей, согласованность source/routing, redaction при abstain и отсутствие публикации непроверенных полей.

### Красные флаги

Тесты используют fixture на каждый regex-паттерн, сверяют точный `m[0]`, роль и индекс сообщения. Отдельный негативный набор ловит отрицания и вопрос бота, чтобы валидная подстрока не маскировала ложное срабатывание.

### Route handlers и SessionStore

Проверяются invalid doctor token, turn caps, идемпотентная финализация, completed conflict, immutable session reads, abort/delivery состояния, error contracts и отсутствие мутации messages по ссылке.

Подробности контрактов: [api-reference.md](./api-reference.md) и [session-lifecycle.md](./session-lifecycle.md).

### Model и analytical layer

Покрываются:

- точная схема `47 × 975` и fail-loud loader;
- vectorization/preprocessing;
- stable softmax и top-5;
- signed top contributions;
- OOL precedence и строгие границы ratio/threshold;
- redaction и fallback;
- routing/urgency и доминирование emergency;
- rich chest, sparse rhinitis, low-back и low-confidence fixtures;
- Python train-time ↔ TypeScript serve-time parity STOP gate.

Parity использует 150 decontaminated held-out rows, покрывает 47/47 классов и допускает не более `1e-7` для vector/logits и `1e-9` для probabilities. Детали: [data-ml-pipeline.md](./data-ml-pipeline.md).

### Offline E2E

`tests/e2e/*.test.ts` и mock scripts проверяют HTTP-сценарии без сети. Слово E2E в имени не превращает mock-run в production evidence: fixture `live_verified` и provenance должны читаться явно.

### PDF и Telegram

Проверяются кириллический TTF, генерация/извлечение текста из PDF, текстовая доставка, fallback при ошибке PDF, Telegram adapters и отсутствие дублирующих уведомлений. Default tests используют mocks и не отправляют сообщения.

## Что запускается отдельно

### Python

Python tests не вызываются из `package.json`. Они проверяют dedupe/decontamination, feature order, pathology/evidence artifacts, export schema, parity fixture provenance, renderer methodology и training artifact contracts.

```bash
ruff check .
.venv/bin/python -m unittest discover -s scripts/tests -v
```

Сырые CSV и `.npz` могут быть нужны отдельным интеграционным сценариям, но не production runtime.

### Eval

```bash
npm run eval -- --allow-unvalidated --check
```

`--check` не регенерирует tracked report. Без него команда пишет `eval/report.json` и `eval/report.md`; это отдельное осознанное действие. Ограничения `mode=no-llm` описаны в [evaluation.md](./evaluation.md).

### Build и standalone health

```bash
npm run build
npm run test:healthz:standalone
```

Standalone runner не входит в Vitest из-за расширения `.mjs`. Он проверяет собранный server, точный shallow health contract и отсутствие зависимости от workspace runtime packages внутри изолированного контейнера.

### Live и production

Live-команды в `package.json` исключены из routine pass. Они требуют явной cost/network-authorisation и корректного внешнего окружения. Их нельзя запускать как автоматический fallback после offline failure.

| Live runner | Фактический результат |
|---|---|
| [`tests/live/llm.smoke.ts`](../tests/live/llm.smoke.ts) | только console output; evidence artifact не записывается |
| [`scripts/live-analytics-smoke.ts`](../scripts/live-analytics-smoke.ts) | только console output; evidence artifact не записывается |
| [`scripts/live-scenario1.ts`](../scripts/live-scenario1.ts) | записывает artifact, но в нём нет обязательных полей commit и endpoint |

Поэтому live-результат не получает commit/endpoint provenance автоматически: console-only вывод нужно сохранять отдельно, а scenario1 artifact — дополнять внешней commit-bound записью. К live-категории также относятся deployment smoke. Секреты не печатаются, а `.env` не читается ради документационного или unit-аудита. См. [deployment.md](./deployment.md) и [security-privacy.md](./security-privacy.md).

## Протокол известного parallel PDF timeout

Принятый P0-прогон на baseline зафиксировал:

| Режим | Результат | Интерпретация |
|---|---:|---|
| Default parallel `npm test` | 885/886 | единственный failure: PDF Cyrillic test превысил 5 s |
| Isolated PDF file | 11/11 | зелёный |
| Serial full Vitest | 886/886 | зелёный |

Это историческое наблюдение конкретного прогона, а не разрешение игнорировать будущие failures.

Порядок разбора:

```bash
# 1. Всегда сначала точная обязательная команда
npm test

# 2. Только если единственный failure — timeout в PDF Cyrillic smoke
npx vitest run tests/smoke/pdf.cyrillic.test.ts

# 3. Затем весь набор последовательно
npx vitest run --maxWorkers=1
```

Классифицировать результат как scheduling flake можно только когда одновременно:

- default failure — единственный и именно timeout, без assertion/error изменения;
- isolated PDF полностью зелёный;
- serial full suite полностью зелёный;
- в отчёте сохранены результаты всех трёх команд и baseline commit.

Если падает другой тест, PDF выдаёт функциональную ошибку, isolated/serial остаётся красным либо timeout повторяется нестабильно — это обычный defect. Нельзя молча повторять команду до зелёного или сообщать, что exact `npm test` прошёл.

## Рекомендуемая матрица по изменениям

| Изменение | Минимум сверх lint/typecheck/default test |
|---|---|
| `scripts/`, schema/feature/artifact | Ruff + Python unittest + parity |
| `models/`, evidence/pathology maps | artifact jq guards + parity + eval `--check` |
| `scripts/eval.ts`, `eval/*` | eval `--check` + publication tests |
| PDF/font/Telegram | isolated PDF + delivery unit tests + build |
| Next config/Docker/health | build + standalone health + deployment config tests |
| API/store/finalize | handler/store tests + mock E2E |
| Frontend | component/state tests + relevant browser verification when available |
| Live/provider boundary | offline guards first, затем отдельно авторизованный live run |

## Read-only аудит состава

```bash
# Vitest files; это не число test cases
find tests -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) | wc -l

# Python inventory
find scripts/tests -type f -name 'test_*.py' | wc -l
rg -n '^\s+def test_' scripts/tests/test_*.py | wc -l

# Что именно включает default runner
sed -n '1,120p' vitest.config.ts

# Наличие/отсутствие CI workflows
find .github -maxdepth 3 -type f 2>/dev/null
```

Статические числа в документах пересчитываются при изменении test tree. Case count всегда указывается вместе с командой, режимом workers и commit.

## Реализация, SPINE и устаревшие описания

| Тема | Реализация `19aa755` | Как читать старые главы |
|---|---|---|
| Test runner | Vitest установлен, 55 включённых файлов | утверждение «runner отсутствует» устарело |
| Golden tests | реализованы и расширены до eval invariants | ранний план описывает исходную цель |
| Parity | реальный Python→TS STOP gate, 150 rows | skipped/placeholder уже не текущий статус |
| E2E | offline mock есть; live отдельно | mock нельзя выдавать за live |
| Python | отдельные 10 файлов/46 methods | `npm test` их не покрывает |
| Standalone health | отдельный `.mjs` runner | default Vitest его не запускает |
| CI | workflows отсутствуют | локальный зелёный проход не является CI evidence |

## Связанные документы

- Архитектура и runtime: [architecture.md](./architecture.md), [runtime-services.md](./runtime-services.md)
- API, session и frontend: [api-reference.md](./api-reference.md), [session-lifecycle.md](./session-lifecycle.md), [frontend.md](./frontend.md)
- ML и eval: [data-ml-pipeline.md](./data-ml-pipeline.md), [evaluation.md](./evaluation.md)
- Деплой, privacy и статус: [deployment.md](./deployment.md), [security-privacy.md](./security-privacy.md), [status.md](./status.md)
