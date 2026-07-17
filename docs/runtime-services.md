# Runtime-сервисы Demeu

> Назначение: справочник по серверным сервисам и фактическому пути выполнения от сообщения пациента до сохранённой и отправленной врачу сводки.
>
> **Обновлено:** 17.07.2026 · **Базовый коммит:** 19aa75528974582de44e5d8b1e7027289776f6e4 · **Канон:** SPINE v2, принятые расхождения и текущие дефекты отмечены отдельно

## Обзор

Demeu исполняется в одном Next.js 15.5 процессе. Python используется только офлайн; production runtime загружает JSON-артефакты и выполняет весь inference на TypeScript.

| Сервис | Основной файл | Назначение | Внешняя сеть |
|---|---|---|:---:|
| Dialogue orchestrator | lib/anamnesis.ts | Приветствие, prompt опросника, DONE marker, Anthropic history boundary | Через LLM client |
| LLM client | lib/llm.ts | Conversational и structured вызовы, timeout/retry/stop_reason | Anthropic |
| Extraction adapter | lib/extract.ts | Транскрипт → Anamnesis + EvidenceVector + unmapped | Через LLM client |
| Red-flag rules | lib/redflags.ts | Patient-only regex-флаги и derived context flags | нет |
| LR scorer | lib/model.ts | JSON artifact → vector → softmax prediction | нет |
| Analytical orchestrator | lib/triage.ts | Source/fallback, abstain, routing, urgency merge, hypothesis | нет дополнительных вызовов |
| SessionStore | lib/store.ts | In-memory token/session state, TTL, delivery status | Telegram только для abort notice |
| Finalizer | lib/finalize.ts | Идемпотентный analyze → complete → background delivery | Через notifier |
| Telegram notifier | lib/telegram.ts | Text broadcast, chunking, aggregate status | Telegram Bot API |
| PDF renderer | lib/pdf.ts | Полная врачебная сводка и транскрипт | нет |
| Health | lib/health.ts, lib/health-deep.ts | Shallow liveness и защищённый extraction probe | Только authorized deep probe |

## Сквозной поток

~~~mermaid
flowchart TD
  A[POST /api/chat] --> B[runAnamnesisTurn]
  B --> C[Anthropic conversational call]
  C --> D{DONE marker, emergency rule<br/>или hard cap?}
  D -- нет --> E[Сохранить user + assistant]
  E --> F[200 done=false]
  D -- да --> G[finalizeSession]
  G --> H[extractAll: structured Anthropic]
  H --> I{extraction_ok?}
  I -- нет --> J[rules_only]
  I -- да --> K[contextFlags]
  K --> L[LR predict]
  L --> M{abstain / model error?}
  M -- нет --> N[model routing]
  M -- abstain --> O[llm_fallback + model audit]
  M -- error --> P[llm_fallback без model]
  J --> Q[mergeUrgency]
  N --> Q
  O --> Q
  P --> Q
  Q --> R[completeSession]
  R --> S[200 result]
  R -. background .-> T[Telegram text всем получателям]
  T -. best effort .-> U[PDF document]
~~~

Важная граница: HTTP result не означает успешную Telegram-доставку. Session завершается до background notification.

## Dialogue orchestrator

### Статическое приветствие

POST /api/chat/start не вызывает LLM. greetingForLanguage возвращает одну из двух констант:

- русский GREETING_RU;
- казахский GREETING_KK.

Приветствие сохраняется в полном Session.messages для UI и PDF.

### Anthropic history boundary

toApiMessages находит первую user-реплику и отдаёт срез от неё до конца. Поэтому:

- полный транскрипт может начинаться с assistant greeting;
- Anthropic Messages API всегда получает user первым;
- последующие assistant/user turns сохраняются;
- фильтровать все assistant-реплики запрещено: это разрушило бы multi-turn контекст.

### DONE marker

stripDoneMarker распознаёт standalone ANAMNESIS_COMPLETE в квадратных скобках или tolerant markdown-обёртке. Границы требуют whitespace/start/end, поэтому составные токены с буквами, цифрами, underscore или hyphen не финализируют сессию.

Safety-ветка prompt требует:

1. посоветовать 103 или приёмный покой;
2. спокойно сообщить о передаче данных врачу;
3. вывести marker последней строкой.

Rule detector дополнительно завершает emergency-ход, если модель пропустила marker.

**Ограничение @ 19aa755:** rule detector запускается после успешного conversational LLM call. Provider failure происходит раньше safety net.

Кодовые якоря: lib/anamnesis.ts:anamnesisSystem, stripDoneMarker, toApiMessages и runAnamnesisTurn; app/api/chat/handler.ts:handleChat.

## LLM client

Используется @anthropic-ai/sdk и model literal claude-sonnet-5.

### Профили запросов

| Параметр | Conversational chat | Structured extraction |
|---|---:|---:|
| max_tokens | 1 024 | 8 000 |
| thinking | disabled | adaptive |
| output effort | low | medium |
| output format | text | JSON Schema |
| timeout одной попытки | 30 секунд | 180 секунд |
| application retries | 1 | 3 |
| максимум попыток | 2 | 4 |
| SDK maxRetries на попытку | 0 | 0 |

Application retry использует:

- начальную задержку 250 мс;
- exponential backoff;
- максимум 10 секунд;
- Retry-After в формате секунд или HTTP-date, также ограниченный 10 секундами.

Retryable:

- API connection/timeout;
- HTTP 408, 409, 429;
- HTTP 5xx;
- structured max_tokens;
- invalid JSON или пустой structured text.

Non-retryable:

- provider refusal.

Для conversational max_tokens частичный непустой текст принимается как ответ. Для structured max_tokens ответ считается обрезанным и повторяется.

Логи содержат operation, event, attempt, stop_reason, status, code и delay; prompt, transcript и response text в этих событиях не записываются.

**Расхождение API:** после исчерпания retry provider 429 превращается в LlmError и route handler возвращает 500 LLM_UNAVAILABLE, а не 429.

Кодовые якоря: lib/llm.ts:withRetries, inspectStopReason, chatTurn и structured.

## Extraction adapter

extractAll выполняет один structured запрос:

~~~text
Полный transcript
  → strict JSON Schema
  → exact-key runtime parser
  → evidence dictionary validation
  → Anamnesis + EvidenceVector + unmapped + audit
~~~

### Доверенная и недоверенная часть

LLM output недоверенный. Runtime:

- проверяет точные ключи объектов;
- требует age integer или null;
- требует severity integer 0–10 или null;
- требует одинаковые age/sex в Anamnesis и EvidenceVector;
- принимает только base codes E_<number>;
- проверяет data type B/C/M;
- проверяет допустимое value;
- отклоняет compound code, duplicate, unknown code/value и неожиданные поля;
- переносит часть отклонённых ссылок в unmapped;
- пишет в audit только категории и индексы, не пациентский текст.

Любая ошибка LLM или shape parsing даёт:

- extraction_ok: false;
- пустой Anamnesis;
- пустой EvidenceVector;
- failure: llm_error или invalid_output.

Analytical orchestrator преобразует это в source=rules_only.

Кодовые якоря: lib/extract.ts:EXTRACT_SCHEMA, parseRawExtraction, sanitizeEvidenceOutput и extractAll.

## Red-flag rules

detectRedFlags и contextFlags — два раздельных прохода.

### Quote flags

detectRedFlags:

- сканирует только role=user;
- рассматривает сообщения отдельно, не склеенный transcript;
- возвращает максимум один flag на rule;
- подавляет локальные отрицания;
- сохраняет raw match как evidence;
- для короткого подтверждения сохраняет patient answer, а preceding assistant question — в elicited_by.

Quote-инвариант:

~~~text
evidence_kind = quote
source_message_index >= 0
messages[source_message_index].role = user
messages[source_message_index].content содержит evidence
evidence не пустой
~~~

### Derived flags

contextFlags рассчитывает:

- pregnancy_risk;
- elderly_severe.

Для них evidence_kind=derived и source_message_index=-1. Подстрочный инвариант не применяется.

Telegram и PDF повторно проверяют evidence перед показом врачу. Невалидная или пустая quote отбрасывается renderer-ом.

**Не проверено:** клиническая полнота regex-набора и качество отрицаний на реальном потоке пациентов. Автотесты подтверждают контракт и frozen fixtures, а не клиническую валидацию.

Кодовые якоря: lib/redflags.ts:RULES, detectRedFlags и contextFlags; lib/telegram.ts:renderFlags; lib/pdf.ts:verifiedFlags.

## LR scorer и routing

Runtime загружает:

- models/triage-lr-v1.json;
- data/pathology_map.json;
- data/evidences_ru.json через model/explainability boundary.

Публичный model API:

| Функция | Назначение |
|---|---|
| loadArtifact | Проверить и загрузить JSON-артефакт |
| buildVector | Построить Float64Array строго по artifact.feature_order и preprocessing |
| predict | Softmax, top-5 pathologies и feature contributions |

predict не принимает решение об abstain. Это делает shouldAbstain в lib/triage.ts.

### Abstain

| Условие | reason |
|---|---|
| Активно меньше двух evidence columns | out_of_label_space |
| unmapped / (active + unmapped) > 0.5 | out_of_label_space |
| max probability ниже artifact threshold | low_confidence |

При abstain:

- model остаётся для аудита;
- model_version и abstain_reason сохраняются;
- pathologies и top_contributions очищаются;
- source становится llm_fallback.

### Routing

Для успешной модели runtime:

1. берёт top-5 pathologies;
2. JOIN-ит их с pathology_map;
3. суммирует вероятности по primary specialty;
4. сортирует и оставляет top-3;
5. определяет base urgency только по pathologies с probability не ниже 0.15;
6. rules merge выполняется после этого.

Pathology map должен ровно покрывать artifact.class_order. Таблица имеет validated:false; routing/urgency не являются врачебно валидированными.

Кодовые якоря: lib/model.ts:loadArtifact, buildVector и predict; lib/triage.ts:shouldAbstain и routeModelPrediction.

## Analytical orchestrator

SPINE описывает семь шагов. Ниже — точное соответствие фактическому коду.

| Шаг SPINE | Реализовано @ 19aa755 | Примечание |
|---:|---|---|
| 1. LLM extraction | extractAll | Один structured вызов |
| 2. Red flags | detectRedFlags до extraction; contextFlags после | Regex safety net не зависит от extraction |
| 3. Model | LIVE_MODEL.predict | Локальный TypeScript |
| 4. Routing | routeModelPrediction | Primary specialty sum, top-3 |
| 5. Rules win | mergeUrgency | Emergency безусловно доминирует |
| 6. Abstain | shouldAbstain до итоговой confidence | Очищает model outputs |
| 7. Hypothesis | Детерминированный текст из extracted chief complaint | Отдельного post-model LLM вызова нет |

### Source matrix

| source | Extraction | model | routing | hypothesis |
|---|---|---|---|---|
| model | успешно | present, abstained=false | Numeric top-3 из модели | Generic complaint text; confidence=top-1 prob |
| llm_fallback | успешно, model abstained | present, пустые outputs | Deterministic fallback route с confidence=0 | Generic complaint text; confidence≤0.5 |
| llm_fallback | успешно, model error/invalid route | absent | Deterministic fallback route с confidence=0 | Generic complaint text; confidence≤0.5 |
| rules_only | extraction failed | absent, model не вызывается | пустой массив | Patient text summary; confidence=0 |

Fallback route:

- emergency → скорая/приёмный покой;
- иначе → терапевт;
- confidence всегда 0.

### Hypothesis: важное расхождение

createProductionLlm создаёт текст вида «Требуется оценка жалобы: <chief complaint>» сразу после extraction. Model path позже меняет confidence, urgency и routing, но не генерирует новый текст из top pathologies или contributions.

Поэтому формулировка «языковая модель сформулировала fallback hypothesis» неточна:

- языковая модель выполнила extraction;
- hypothesis sentence сформировал TypeScript template;
- отдельного provider request на hypothesis нет.

### Model presence edge case

Golden paths:

- model success → model present;
- model abstain → model present;
- extraction failure → model skipped и absent.

Если predict был вызван, но prediction validation или routing затем бросили ошибку, общий catch удаляет model и оставляет llm_fallback. Строгая фраза SPINE «model присутствует тогда и только тогда, когда модель реально считалась» для этого edge case не обеспечена и не покрыта golden test.

Кодовые якоря: lib/triage.ts:createProductionLlm, rulesOnlyResult, analyze, mergeUrgency.

## Finalizer

finalizeSession — общая точка для chat auto-finalize и ручного finalize.

Алгоритм:

1. Получить session.
2. Если completed — вернуть сохранённый result с replayed=true.
3. Если не collecting — бросить SessionNotCollectingError.
4. Если нет patient messages — бросить NothingToAnalyzeError.
5. Выполнить analyze.
6. Atomically перейти в completed через SessionStore.
7. Запланировать doctor delivery через Next after.
8. Вернуть result, не ожидая delivery.

Concurrent finalize для одной пары store/sessionId coalesce-ится через WeakMap + in-flight Map.

Если Telegram не настроен, используется порт, который бросает ошибку в background work; deliveryStatus становится failed.

Если background scheduler сам отклоняет постановку работы, session остаётся completed, а deliveryStatus становится failed.

Кодовый якорь: lib/finalize.ts:finalizeOnce и finalizeSession.

## Telegram notifier

### Конфигурация

| Переменная | Семантика |
|---|---|
| TELEGRAM_BOT_TOKEN | Bot API token |
| TELEGRAM_DOCTOR_CHAT_IDS | Primary comma-separated recipient list |
| TELEGRAM_DOCTOR_CHAT_ID | Legacy single-recipient fallback |

Plural list:

- trim;
- stable order;
- deduplication;
- signed 64-bit nonzero integer validation;
- invalid nonblank value fail-closed.

### Completed broadcast

TelegramNotifier:

1. рендерит self-contained summary;
2. делит её на chunks до 4 096 символов;
3. добавляет обязательную отрицательную оговорку в каждый chunk;
4. рендерит один PDF;
5. пытается отправить каждый text chunk каждому recipient;
6. продолжает после ошибки chunk или recipient;
7. пытается отправить PDF каждому recipient;
8. после всех попыток бросает privacy-safe aggregate, если обязательный text не дошёл хотя бы одному recipient.

PDF rendering и sendDocument — best effort. Их ошибка не делает успешный text broadcast failed.

deliveryStatus агрегирован по session:

- sent означает, что обязательный text дошёл всем; PDF мог не дойти;
- failed означает, что text не дошёл хотя бы одному; часть recipients/chunks могла быть доставлена.

Автоматического retry нет. Replayed finalize не отправляет повторно.

### Aborted notice

Started abandoned session получает text-only notice с:

- sessionId;
- doctorToken;
- startedAt;
- abortedAt;
- reason.

PDF и TriageResult не отправляются. Zero-turn session удаляется без notice.

Кодовые якоря: lib/telegram.ts:parseTelegramDoctorChatIds, TelegramNotifier.sendDoctorSummary и sendAbortedNotice; lib/store.ts:abortSession.

## PDF renderer

renderSummaryPdf:

- использует repository-local IBM Plex Sans и Lora;
- embed-ит subset шрифтов через fontkit;
- создаёт A4 pages с pagination;
- фильтрует непроверяемые quote flags;
- показывает priority, flags, routing, hypothesis, model/audit, anamnesis;
- добавляет полный transcript, включая assistant и patient messages.

PDF отправляется как demeu-summary.pdf только через Telegram. HTTP endpoint для него отсутствует.

**Privacy-следствие:** свободный текст пациента уходит в Telegram как содержимое document, даже если text summary содержит только структурированные поля и отдельные цитаты.

Кодовый якорь: lib/pdf.ts:verifiedFlags, summaryBlocks и renderSummaryPdf.

## Health services

### Shallow

buildHealthResponse не делает сеть:

- ok=true;
- commit из COMMIT_SHA или unknown;
- model_version из загруженного artifact;
- llm_ok=true только при наличии ANTHROPIC_API_KEY.

### Deep

handleHealthRequest для probe=extract:

- требует HMAC, bound к commit;
- сравнивает proof constant-time;
- отклоняет missing/wrong proof статусом 404 до provider;
- вызывает synthetic extraction максимум один раз;
- принудительно отключает application retries;
- single-flight-ит concurrent requests;
- кеширует success или failure на process lifetime.

Production Next standalone добавляет x-forwarded-* даже loopback request; эти заголовки не являются auth boundary. Граница — proof.

Не используйте deep probe как публичный uptime check: он платный при первом корректно авторизованном вызове процесса.

Кодовые якоря: lib/health.ts:buildHealthResponse, lib/health-deep.ts:createExtractionProbe, createCachedExtractionProbe и handleHealthRequest.

## Timeout budget и frontend

| Операция | Server attempt budget | Frontend timeout |
|---|---:|---:|
| Conversational chat | 30 сек × до 2 attempts + backoff | 45 сек |
| Final analysis внутри chat | Structured budget ниже | Тот же общий 45 сек |
| Explicit finalize | 180 сек × до 4 attempts + backoff | 60 сек |

Frontend timeout короче worst-case server budget. Browser может показать retry, пока server продолжает работу. Идемпотентный finalize и replay помогают восстановить result, но не гарантируют мгновенную согласованность.

Кодовые якоря: lib/llm.ts:CHAT_TIMEOUT_MS и STRUCTURED_TIMEOUT_MS; lib/http.ts:sendChat и finalizeChat.

## Environment ownership

| Variable | Runtime consumer |
|---|---|
| ANTHROPIC_API_KEY | Anthropic SDK, shallow/deep health |
| TELEGRAM_BOT_TOKEN | telegramNotifierFromEnv |
| TELEGRAM_DOCTOR_CHAT_IDS | telegramNotifierFromEnv |
| TELEGRAM_DOCTOR_CHAT_ID | telegramNotifierFromEnv legacy fallback |
| COMMIT_SHA | Health provenance |
| NODE_ENV | Next runtime |
| DOCTOR_ACCESS_CODE | **Нет runtime consumer @ 19aa755** |
| APP_BASE_URL | Deploy configuration; frontend link использует window.location.origin |
| DEMEU_DOMAIN | Deploy/TLS |
| TLS_BRANCH | Deploy/TLS |

## Основные ограничения

- In-memory state не подходит для нескольких replicas.
- Chat turns не имеют per-session mutex; concurrent turns могут пересечь read/LLM/append.
- Emergency rule path зависит от успешного conversational LLM turn.
- Нет отдельного post-model hypothesis call.
- Model failure после invocation может быть скрыт отсутствующим model object.
- Telegram delivery asynchronous, one-way и без durable retry queue.
- PDF содержит полный transcript.
- Routing table имеет validated:false.
- End-to-end Kazakh extraction quality **не проверено**.

## См. также

- [Архитектура](./architecture.md)
- [API](./api-reference.md)
- [Жизненный цикл сессии](./session-lifecycle.md)
- [Безопасность и приватность](./security-privacy.md)
- [Data/ML pipeline](./data-ml-pipeline.md)
- [Оценка качества](./evaluation.md)
- [Тестирование](./testing.md)
- [Деплой](./deployment.md)
- [Статус](./status.md)
