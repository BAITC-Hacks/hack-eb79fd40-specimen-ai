# API Demeu

> Назначение: точный справочник HTTP API, который реализован в Demeu на указанном базовом коммите. Целевой контракт SPINE приведён отдельно и не подменяет фактическое поведение.
>
> **Обновлено:** 17.07.2026 · **Базовый коммит:** 19aa75528974582de44e5d8b1e7027289776f6e4 · **Канон:** SPINE v2, расхождения отмечены явно

## Статусы в этом документе

| Метка | Значение |
|---|---|
| **Реализовано @ 19aa755** | Поведение следует из исходного кода и принято тестами на базовом коммите |
| **Цель SPINE** | Замороженный контракт, к которому должна стремиться реализация |
| **Расхождение** | Реализация и SPINE различаются; клиентам нельзя молча обещать целевое поведение |
| **Не проверено** | Утверждение не подтверждено на базовом коммите или живой внешней системой |

## Базовый URL и формат

Локально:

~~~text
http://localhost:3000
~~~

Production-origin задаётся деплоем. Актуальный адрес и TLS-процедуру см. в [деплое](./deployment.md) и [статусе](./status.md); этот справочник не фиксирует домен как вечный контракт.

Все прикладные ответы — JSON. Тела POST-запросов, кроме POST /api/link, передаются как application/json.

## Фактическая граница доступа

**Реализовано @ 19aa755:**

| Поверхность | Проверка доступа |
|---|---|
| POST /api/link | Нет проверки доступа |
| POST /api/chat/start | Выданный этим процессом 16-символьный doctor token в теле |
| POST /api/chat | Только UUID сессии в теле |
| POST /api/chat/finalize | Только UUID сессии в теле |
| GET /api/healthz | Публичный shallow health |
| GET /api/healthz?probe=extract | Commit-bound HMAC в заголовке x-demeu-health-proof |

Doctor token и session UUID фактически являются bearer-идентификаторами: владелец значения может вызвать соответствующий эндпоинт. Отдельной пользовательской или врачебной сессии аутентификации нет.

**Расхождение:** SPINE требует опциональный DOCTOR_ACCESS_CODE для POST /api/link и ответ 401 UNAUTHORIZED при неверном коде. Текущий route handler не читает запрос и не проверяет заголовок. Frontend умеет отправлять x-doctor-code, но backend его игнорирует.

**Расхождение:** rate limiting не реализован ни на одном route handler. Код приложения не возвращает 429 и не устанавливает Retry-After.

Кодовые якоря: app/api/link/route.ts:5, lib/http.ts:createLink, app/api/chat/start/handler.ts:handleChatStart, lib/health-deep.ts:handleHealthRequest.

## Сводная таблица

| Метод | Путь | Назначение | Успех |
|---|---|---|---|
| POST | /api/link | Создать doctor token для новой ссылки | 200 { token } |
| POST | /api/chat/start | Создать сессию и получить статическое приветствие | 200 { sessionId, reply, turnsLeft } |
| POST | /api/chat | Выполнить один ход; при завершении сразу сформировать результат | 200 { reply, done, turnsLeft, result? } |
| POST | /api/chat/finalize | Завершить сессию вручную или получить сохранённый результат | 200 { result, source, replayed } |
| GET | /api/healthz | Проверить процесс, артефакт и наличие LLM-конфигурации | 200 { ok, commit, model_version, llm_ok } |

## Общий формат ошибки

Большинство route handlers возвращает:

~~~json
{
  "error": "<безопасное сообщение>",
  "code": "<STABLE_CODE>",
  "request_id": "<uuid>"
}
~~~

Frontend не показывает server error text пользователю: он сохраняет только status, code, request_id и retry metadata.

Исключения:

- POST /api/link при 500 не добавляет request_id.
- Некорректный JSON в POST /api/chat/start сейчас становится 500 INTERNAL, а не 400.
- Unauthorized deep health возвращает обычное четырёхпольное health-тело со статусом 404, а не error envelope.

Кодовые якоря: app/api/chat/handler.ts:apiError, app/api/chat/finalize/handler.ts:apiError, lib/http.ts:requestJson.

---

## POST /api/link

Создаёт новый doctor token. Токен затем помещается в путь /c/<token>.

### Request

Тело не требуется.

~~~bash
curl -sS -X POST "$BASE_URL/api/link"
~~~

Frontend может добавить заголовок:

~~~text
x-doctor-code: <doctor-access-code>
~~~

**Реализовано @ 19aa755:** route handler игнорирует этот заголовок.

### Response 200

~~~json
{
  "token": "<16-lowercase-hex>"
}
~~~

Токен:

- генерируется из UUID;
- содержит 16 строчных hex-символов;
- живёт семь суток в памяти процесса;
- допускает создание нескольких сессий;
- не становится недействительным после первого старта.

### Ошибки

| HTTP | code | Когда |
|---:|---|---|
| 500 | INTERNAL | Не удалось получить singleton store или создать токен |

### SPINE и расхождение

| Цель SPINE | Реализовано @ 19aa755 |
|---|---|
| При заданном DOCTOR_ACCESS_CODE проверять код и возвращать 401 UNAUTHORIZED | Проверки нет; эндпоинт открыт |
| 429 используется для rate limiting | Rate limiter отсутствует |

Кодовые якоря: app/api/link/route.ts:POST, lib/store.ts:MemorySessionStore.createDoctorToken, lib/doctor-ui.ts:buildPatientLink.

---

## POST /api/chat/start

Проверяет doctor token, создаёт collecting-сессию и возвращает статическое приветствие. LLM на старте не вызывается.

### Request

~~~json
{
  "token": "<16-lowercase-hex>",
  "language": "ru"
}
~~~

| Поле | Тип | Обязательное | Ограничение |
|---|---|:---:|---|
| token | string | да | Ровно 16 строчных hex-символов |
| language | "ru" или "kk" | нет | По умолчанию ru; поле lang не является алиасом |

### Response 200

~~~json
{
  "sessionId": "<uuid>",
  "reply": "<static-greeting>",
  "turnsLeft": 20
}
~~~

Приветствие сохраняется в Session.messages как assistant-сообщение, но Anthropic boundary позже отбрасывает всё до первой реплики пациента.

### Ошибки

| HTTP | code | Когда |
|---:|---|---|
| 400 | TOKEN_REQUIRED | token отсутствует, имеет неверный тип или не соответствует 16 lowercase hex |
| 400 | BAD_REQUEST | Передано неподдерживаемое значение language |
| 404 | TOKEN_NOT_FOUND | Формат токена корректен, но токен неизвестен или истёк |
| 500 | INTERNAL | Ошибка JSON parsing или SessionStore |

**Расхождение:** malformed JSON попадает во внешний catch и возвращает 500 INTERNAL. Документация не должна обещать 400 до изменения handler.

Кодовые якоря: app/api/chat/start/handler.ts:handleChatStart, lib/anamnesis.ts:greetingForLanguage, lib/store.ts:isValidDoctorToken.

---

## POST /api/chat

Выполняет разговорный ход. Один запрос может либо вернуть следующий вопрос, либо синхронно сформировать полный TriageResult.

### Request

~~~json
{
  "sessionId": "<uuid>",
  "message": "<patient-message>"
}
~~~

| Поле | Тип | Ограничение |
|---|---|---|
| sessionId | string | После trim не пустой |
| message | string | После trim не пустой, не более 2 000 UTF-16 code units |

### Response 200: опрос продолжается

~~~json
{
  "reply": "<assistant-reply>",
  "done": false,
  "turnsLeft": 15
}
~~~

### Response 200: опрос завершён

~~~json
{
  "reply": "<closing-reply>",
  "done": true,
  "turnsLeft": 0,
  "result": {
    "source": "llm_fallback",
    "urgency": "planned",
    "red_flags": [],
    "routing": [
      {
        "specialty": "терапевт",
        "confidence": 0
      }
    ]
  }
}
~~~

Пример сокращён: фактический result обязан содержать все поля TriageResult из lib/types.ts.

Завершение запускается, если:

1. conversational LLM вернул самостоятельный DONE marker;
2. patient-only rule detector нашёл emergency-флаг;
3. принят двадцатый ход пациента;
4. запрос пришёл к collecting-сессии, уже достигшей hard cap после предыдущего сбоя анализа.

Turn cap — штатное завершение, не ошибка.

### Ошибки

| HTTP | code | Когда |
|---:|---|---|
| 400 | BAD_REQUEST | Тело не является JSON |
| 400 | SESSION_ID_REQUIRED | Нет непустого sessionId |
| 400 | MESSAGE_REQUIRED | message пуст, неверного типа или длиннее лимита |
| 404 | SESSION_NOT_FOUND | Сессия неизвестна |
| 409 | SESSION_COMPLETED | Сессия completed или aborted |
| 500 | LLM_UNAVAILABLE | Conversational LLM не ответил после retry policy |
| 500 | ANALYZE_FAILED | Финальный аналитический слой не сформировал результат |
| 500 | INTERNAL | Ошибка store или неполная запись хода |

**Расхождение:** LLM-ошибка, включая исчерпанный retry после provider 429, маппится в 500 LLM_UNAVAILABLE. Route handler не проксирует 429 и Retry-After.

**Safety-ограничение:** emergency rule detector вызывается только после успешного conversational LLM turn. Если этот вызов падает, emergency-фраза не сохраняется и автофинализация не запускается.

Кодовые якоря: app/api/chat/handler.ts:handleChat, lib/anamnesis.ts:runAnamnesisTurn, lib/redflags.ts:detectRedFlags, lib/finalize.ts:finalizeSession.

---

## POST /api/chat/finalize

Принудительно завершает collecting-сессию. Это тот же finalizeSession, который использует POST /api/chat.

### Request

~~~json
{
  "sessionId": "<uuid>"
}
~~~

### Response 200

~~~json
{
  "result": {
    "source": "model",
    "urgency": "planned"
  },
  "source": "model",
  "replayed": false
}
~~~

Пример сокращён. source на верхнем уровне обязан совпадать с result.source.

| replayed | Значение |
|---|---|
| false | Анализ выполнен этим вызовом, результат впервые сохранён |
| true | Сессия уже completed; возвращён сохранённый result без повторного анализа и доставки |

### Ошибки

| HTTP | code | Когда |
|---:|---|---|
| 400 | BAD_REQUEST | Тело не является JSON или в сессии нет ни одной реплики пациента |
| 400 | SESSION_ID_REQUIRED | Нет непустого sessionId |
| 404 | SESSION_NOT_FOUND | Сессия неизвестна |
| 409 | SESSION_COMPLETED | Сессия aborted; completed-сессия вместо этого возвращает replay |
| 500 | ANALYZE_FAILED | Анализ или completion transition завершились ошибкой |

**Цель SPINE:** повтор completed должен быть идемпотентным. **Реализовано @ 19aa755:** in-flight вызовы также coalesce-ятся по паре store/sessionId.

Кодовые якоря: app/api/chat/finalize/handler.ts:handleFinalize, lib/finalize.ts:finalizeSession и finalizeOnce.

---

## GET /api/healthz

### Shallow health

~~~bash
curl -sS "$BASE_URL/api/healthz"
~~~

~~~json
{
  "ok": true,
  "commit": "<build-commit-or-unknown>",
  "model_version": "lr-v1",
  "llm_ok": true
}
~~~

| Поле | Фактическая семантика |
|---|---|
| ok | Процесс отвечает и смог загрузить health dependencies |
| commit | COMMIT_SHA из image build или unknown |
| model_version | Версия реально загруженного JSON-артефакта |
| llm_ok | Только наличие ANTHROPIC_API_KEY; сетевой вызов не выполняется |

Shallow health всегда 200, пока handler может сформировать ответ.

### Защищённый deep extraction probe

Внутренний deployment gate использует:

~~~text
GET /api/healthz?probe=extract
x-demeu-health-proof: <commit-bound-hmac>
~~~

Без корректного proof или без ключа:

- HTTP 404;
- то же четырёхпольное health-тело;
- llm_ok: false;
- provider call не выполняется.

С корректным proof:

- выполняется не более одного structured extraction request;
- application retries равны нулю;
- результат single-flight-ится и кешируется на всё время жизни процесса;
- HTTP 200 возвращается и при корректно авторизованной, но неуспешной extraction; тогда llm_ok: false.

Не публикуйте proof или ключ. Операционный вызов описан в [деплое](./deployment.md).

**Расхождение:** deep query — позднее расширение поверх SPINE health-контракта; его 404 нельзя переносить на обычный /api/healthz.

Кодовые якоря: app/api/healthz/route.ts:GET, lib/health.ts:buildHealthResponse, lib/health-deep.ts:computeDeepHealthProof, createCachedExtractionProbe и handleHealthRequest.

## Полный перечень кодов

| HTTP | code | Эндпоинты |
|---:|---|---|
| 400 | BAD_REQUEST | chat, finalize; start для invalid language |
| 400 | TOKEN_REQUIRED | chat/start |
| 400 | SESSION_ID_REQUIRED | chat, finalize |
| 400 | MESSAGE_REQUIRED | chat |
| 404 | TOKEN_NOT_FOUND | chat/start |
| 404 | SESSION_NOT_FOUND | chat, finalize |
| 409 | SESSION_COMPLETED | chat; finalize для aborted |
| 500 | LLM_UNAVAILABLE | chat |
| 500 | ANALYZE_FAILED | chat, finalize |
| 500 | INTERNAL | link, start, chat |

401 UNAUTHORIZED и 429 RATE_LIMITED — **цель SPINE, но не реализованное поведение @ 19aa755**.

## Клиентский response guard

lib/http.ts проверяет:

- связность done и result;
- полный shape TriageResult;
- emergency dominance;
- допустимое присутствие model для source;
- model confidence для source=model;
- confidence cap для llm_fallback;
- confidence=0 для rules_only;
- обязательную отрицательную оговорку «это не диагноз, решает врач»;
- source верхнего finalize response равен result.source.

Malformed 2xx становится frontend failure kind bad_json и не рендерится как валидный результат.

Кодовый якорь: lib/http.ts:isTriageResult, isChatResponse, isFinalizeResponse и requestJson.

## Известные ограничения API

- Нет CORS-конфигурации уровня приложения, отдельной CSRF-защиты и route-level rate limiting.
- POST /api/link открыт.
- Doctor token многократный и не привязан к одному пациенту.
- Session UUID — единственная граница chat/finalize/replay.
- Полный TriageResult приходит в браузер пациента.
- Нет GET session и восстановления после reload.
- Нет endpoint для скачивания PDF: файл отправляется только через Telegram.
- Нет endpoint для явного abort при закрытии вкладки.
- In-memory state не разделяется между процессами и исчезает при рестарте.

## Файлы реализации

| Область | Якорь |
|---|---|
| Link | app/api/link/route.ts:POST |
| Start | app/api/chat/start/handler.ts:handleChatStart |
| Chat | app/api/chat/handler.ts:handleChat |
| Finalize | app/api/chat/finalize/handler.ts:handleFinalize |
| Shared finalizer | lib/finalize.ts:finalizeSession |
| Frontend adapter | lib/http.ts:requestJson |
| Health | lib/health.ts и lib/health-deep.ts |
| Типы | lib/types.ts |

## См. также

- [Архитектура](./architecture.md)
- [Runtime-сервисы](./runtime-services.md)
- [Жизненный цикл сессии](./session-lifecycle.md)
- [Frontend](./frontend.md)
- [Безопасность и приватность](./security-privacy.md)
- [Тестирование](./testing.md)
- [Статус](./status.md)
