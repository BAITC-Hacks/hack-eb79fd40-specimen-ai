export type ApiMethod = "GET" | "POST" | "DELETE";
export type ApiGroupId = "system" | "patient" | "auth" | "intakes" | "referrals" | "analytics";
export type CodeLanguage = "curl" | "fetch";

export interface ApiField {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export type ApiErrorSpec =
  | { status: number; code: string; meaning: string; response?: never }
  | { status: number; code?: never; meaning: string; response: unknown };

export interface ApiEndpoint {
  id: string;
  groupId: ApiGroupId;
  method: ApiMethod;
  path: string;
  summary: string;
  description: string;
  auth: {
    label: string;
    detail: string;
    kind: "public" | "conditional" | "patient" | "workspace";
  };
  request: {
    contentType: "application/json" | "none";
    fields: readonly ApiField[];
    example: Record<string, unknown> | null;
    note?: string;
  };
  success: {
    status: number;
    description: string;
    example: unknown;
  };
  errors: readonly ApiErrorSpec[];
  notes?: readonly string[];
}

export interface ApiGroup {
  id: ApiGroupId;
  eyebrow: string;
  title: string;
  description: string;
}

export interface FlowStory {
  id: string;
  index: string;
  title: string;
  outcome: string;
  steps: readonly { endpointId: string; label: string; detail: string }[];
}

const field = (name: string, type: string, required: boolean, description: string): ApiField => ({
  name,
  type,
  required,
  description,
});

const error = (status: number, code: string, meaning: string): ApiErrorSpec => ({ status, code, meaning });
const responseError = (status: number, meaning: string, response: unknown): ApiErrorSpec => ({
  status,
  meaning,
  response,
});

const workspaceErrors = [
  error(400, "BAD_REQUEST", "Тело или параметры не прошли строгую проверку."),
  error(401, "UNAUTHORIZED", "Сессия врача отсутствует или истекла."),
  error(403, "FORBIDDEN", "Роль или организация не дают доступа к операции."),
  error(413, "BODY_TOO_LARGE", "Тело превышает серверный предел."),
  error(503, "WORKSPACE_UNAVAILABLE", "Рабочее пространство не настроено или недоступно."),
] as const;

const referralErrors = [
  ...workspaceErrors,
  error(404, "NOT_FOUND", "Запись не найдена в доступной области."),
  error(409, "REVISION_CONFLICT", "Карточка уже изменилась; загрузите свежую ревизию."),
  error(409, "IDEMPOTENCY_CONFLICT", "Ключ уже применён к другому изменению."),
] as const;

const doctorAccess = {
  personalRecords: "own",
  aggregateRecords: "own",
  aggregatePrivacy: "direct",
} as const;

export const apiGroups: readonly ApiGroup[] = [
  {
    id: "system",
    eyebrow: "00 · Runtime",
    title: "Состояние сервиса",
    description: "Дешёвая проверка процесса и защищённая проверка аналитического контура.",
  },
  {
    id: "patient",
    eyebrow: "01 · Patient journey",
    title: "Ссылка и опрос",
    description: "Одноразовая ссылка, защищённая сессия пациента, диалог и идемпотентное завершение.",
  },
  {
    id: "auth",
    eyebrow: "02 · Access",
    title: "Рабочее пространство",
    description: "Вход, чтение текущей роли и завершение cookie-сессии.",
  },
  {
    id: "intakes",
    eyebrow: "03 · Intake",
    title: "Завершённые опросы",
    description: "Врачебный список сессий и безопасная карточка результата в пределах организации.",
  },
  {
    id: "referrals",
    eyebrow: "04 · Referral",
    title: "Направления",
    description: "Комплектность, история подтверждений, обследования, памятка и доставка врачу.",
  },
  {
    id: "analytics",
    eyebrow: "05 · Oversight",
    title: "Агрегаты",
    description: "Обезличенный срез потока с серверным ограничением малых групп.",
  },
] as const;

const anon = { kind: "public", label: "Без авторизации", detail: "Не возвращает персональные данные." } as const;
const workspace = {
  kind: "workspace",
  label: "Cookie рабочего пространства",
  detail: "HttpOnly SameSite=Strict cookie. Доступ ограничен ролью и организацией.",
} as const;
const patient = {
  kind: "patient",
  label: "Cookie пациента + same-origin",
  detail: "Capability-cookie привязан к sessionId; браузер отправляет его автоматически.",
} as const;

export const apiEndpoints: readonly ApiEndpoint[] = [
  {
    id: "health",
    groupId: "system",
    method: "GET",
    path: "/api/healthz",
    summary: "Проверить liveness",
    description: "Возвращает версию сборки и готовность режима обработки без платного сетевого вызова.",
    auth: anon,
    request: { contentType: "none", fields: [], example: null, note: "Опциональный probe=extract защищён доказательством и не предназначен для частого polling." },
    success: {
      status: 200,
      description: "Процесс отвечает.",
      example: { ok: true, commit: "a1b2c3d", model_version: "lr-v1", llm_ok: true, processing_mode: "external_llm" },
    },
    errors: [responseError(
      404,
      "Только глубокая проверка: тот же health body с llm_ok=false, если доказательство неверно или контур не готов.",
      { ok: true, commit: "a1b2c3d", model_version: "lr-v1", llm_ok: false, processing_mode: "external_llm" },
    )],
    notes: ["Обычный health всегда остаётся дешёвым.", "Значение commit позволяет сверить реально запущенную сборку."],
  },
  {
    id: "create-link",
    groupId: "patient",
    method: "POST",
    path: "/api/link",
    summary: "Создать ссылку пациенту",
    description: "В рабочем режиме связывает новый токен с текущим врачом. В legacy-режиме принимает код доступа.",
    auth: { kind: "conditional", label: "Workspace cookie или x-doctor-code", detail: "В production рабочее пространство имеет приоритет; код применяется только в legacy-режиме." },
    request: { contentType: "application/json", fields: [], example: {}, note: "Каждый успешный вызов создаёт новый одноразовый токен." },
    success: { status: 200, description: "Токен для ссылки /c/{token}.", example: { token: "7fa31c2b940e4a71" } },
    errors: [error(401, "UNAUTHORIZED", "Врач не вошёл или код доступа неверен."), error(403, "FORBIDDEN", "Роль аналитика не создаёт ссылки."), error(409, "OWNER_CONFLICT", "Сгенерированный токен уже принадлежит другому врачу."), error(429, "RATE_LIMITED", "Лимит создания ссылок превышен."), error(500, "INTERNAL", "Не удалось создать или привязать ссылку."), error(503, "WORKSPACE_UNAVAILABLE", "Конфигурация рабочего пространства неполна.")],
  },
  {
    id: "chat-start",
    groupId: "patient",
    method: "POST",
    path: "/api/chat/start",
    summary: "Открыть опрос",
    description: "Проверяет токен, создаёт сессию и без обращения к модели возвращает приветствие.",
    auth: { kind: "conditional", label: "Токен ссылки + same-origin", detail: "В рабочем режиме ответ устанавливает HttpOnly capability-cookie пациента." },
    request: {
      contentType: "application/json",
      fields: [field("token", "16 hex chars", true, "Одноразовый токен из ссылки."), field("language", '"ru" | "kk"', false, "Язык опроса; по умолчанию ru.")],
      example: { token: "7fa31c2b940e4a71", language: "ru" },
    },
    success: { status: 200, description: "Сессия создана, приветствие готово.", example: { sessionId: "a94648da-2d5e-4fe0-9010-72e972733850", reply: "Здравствуйте! Что вас беспокоит?", turnsLeft: 20 } },
    errors: [error(400, "TOKEN_REQUIRED", "Токен отсутствует или имеет неверный формат."), error(400, "BAD_REQUEST", "Язык или JSON не прошли проверку."), error(403, "FORBIDDEN", "Запрос пришёл не с разрешённого origin."), error(404, "TOKEN_NOT_FOUND", "Ссылка неизвестна или больше не действует."), error(409, "LINK_ALREADY_USED", "Одноразовая ссылка уже была использована."), error(413, "BODY_TOO_LARGE", "Тело превышает 16 KiB."), error(500, "INTERNAL", "Внутренняя ошибка создания сессии."), error(503, "WORKSPACE_UNAVAILABLE", "Защищённый режим не настроен.")],
  },
  {
    id: "chat-resume",
    groupId: "patient",
    method: "POST",
    path: "/api/chat/resume",
    summary: "Восстановить вкладку",
    description: "Возвращает безопасное состояние активной или завершённой сессии без врачебных полей в terminal response.",
    auth: patient,
    request: { contentType: "application/json", fields: [field("sessionId", "uuid", true, "Текущая сессия."), field("token", "16 hex chars", true, "Исходный токен ссылки."), field("requestId", "string 16–128", false, "Ключ безопасного повтора восстановления.")], example: { sessionId: "a94648da-2d5e-4fe0-9010-72e972733850", token: "7fa31c2b940e4a71" } },
    success: { status: 200, description: "Сообщения и безопасное состояние пациента.", example: { sessionId: "a94648da-2d5e-4fe0-9010-72e972733850", language: "ru", status: "collecting", turnsLeft: 14, messages: [{ role: "assistant", content: "Здравствуйте! Что вас беспокоит?" }] } },
    errors: [error(400, "BAD_REQUEST", "JSON или ключ повтора не прошли проверку."), error(401, "UNAUTHORIZED", "Cookie или токен не соответствуют сессии."), error(403, "FORBIDDEN", "Origin не совпал."), error(404, "NOT_FOUND", "Восстановление недоступно в legacy-режиме."), error(404, "SESSION_NOT_FOUND", "Сессия истекла или удалена."), error(409, "IDEMPOTENCY_CONFLICT", "Ключ повтора уже связан с другим телом."), error(413, "BODY_TOO_LARGE", "Тело превышает 16 KiB."), error(500, "INTERNAL", "Внутренняя ошибка чтения сессии."), error(503, "WORKSPACE_UNAVAILABLE", "Защищённый режим не настроен.")],
  },
  {
    id: "chat-turn",
    groupId: "patient",
    method: "POST",
    path: "/api/chat",
    summary: "Отправить реплику",
    description: "Проводит один ход. При красном флаге или hard cap тот же ответ может завершить сессию.",
    auth: patient,
    request: { contentType: "application/json", fields: [field("sessionId", "uuid", true, "Идентификатор сессии."), field("message", "string ≤ 2000", true, "Одна реплика пациента."), field("requestId", "string 16–128", false, "Ключ безопасного повтора того же хода.")], example: { sessionId: "a94648da-2d5e-4fe0-9010-72e972733850", message: "Сильная давящая боль в груди и тяжело дышать", requestId: "turn-demo-000001" } },
    success: { status: 200, description: "Следующий вопрос или безопасное завершение.", example: { reply: "Спасибо. Передаю ответы врачу.", done: true, turnsLeft: 0, closing: { emergency: true, text: "Ваши ответы переданы врачу." } } },
    errors: [error(400, "BAD_REQUEST", "JSON или ключ повтора не прошли проверку."), error(400, "SESSION_ID_REQUIRED", "Идентификатор отсутствует."), error(400, "MESSAGE_REQUIRED", "Сообщение пустое, слишком длинное или неверного типа."), error(401, "UNAUTHORIZED", "Нет capability-cookie этой сессии."), error(403, "FORBIDDEN", "Origin не совпал."), error(404, "SESSION_NOT_FOUND", "Сессия неизвестна или истекла."), error(409, "IDEMPOTENCY_CONFLICT", "Ключ повтора уже связан с другим телом."), error(409, "SESSION_COMPLETED", "Сессия уже завершена."), error(409, "TURN_PENDING", "Предыдущая реплика ещё обрабатывается."), error(413, "BODY_TOO_LARGE", "Тело превышает 16 KiB."), error(500, "LLM_UNAVAILABLE", "Диалоговый слой недоступен после ретрая."), error(500, "ANALYZE_FAILED", "Не удалось собрать итог даже на правилах."), error(500, "INTERNAL", "Внутренняя ошибка сохранения хода."), error(503, "WORKSPACE_UNAVAILABLE", "Защищённый режим не настроен.")],
    notes: ["Emergency-правила имеют приоритет над выходом модели.", "Врачебная сводка не возвращается в браузер пациента."],
  },
  {
    id: "chat-finalize",
    groupId: "patient",
    method: "POST",
    path: "/api/chat/finalize",
    summary: "Завершить опрос",
    description: "Идемпотентно собирает результат и ставит доставку врачу; повтор не создаёт второе уведомление.",
    auth: patient,
    request: { contentType: "application/json", fields: [field("sessionId", "uuid", true, "Сессия с хотя бы одной репликой пациента."), field("requestId", "string 16–128", false, "Ключ безопасного повтора финализации.")], example: { sessionId: "a94648da-2d5e-4fe0-9010-72e972733850", requestId: "finalize-demo-001" } },
    success: { status: 200, description: "Пациент получает только безопасный closing.", example: { replayed: false, closing: { emergency: false, text: "Спасибо. Ваши ответы переданы врачу." } } },
    errors: [error(400, "SESSION_ID_REQUIRED", "Идентификатор отсутствует."), error(400, "BAD_REQUEST", "В сессии пока нечего анализировать или ключ повтора неверен."), error(401, "UNAUTHORIZED", "Нет capability-cookie этой сессии."), error(403, "FORBIDDEN", "Origin не совпал."), error(404, "SESSION_NOT_FOUND", "Сессия неизвестна или истекла."), error(409, "SESSION_COMPLETED", "Сессия была прервана и закрыта."), error(409, "IDEMPOTENCY_CONFLICT", "Ключ повтора уже связан с другим телом."), error(413, "BODY_TOO_LARGE", "Тело превышает 16 KiB."), error(500, "ANALYZE_FAILED", "Не удалось собрать даже результат на правилах."), error(500, "INTERNAL", "Внутренняя ошибка проверки защищённой сессии."), error(503, "WORKSPACE_UNAVAILABLE", "Защищённый режим не настроен.")],
  },
  {
    id: "auth-state",
    groupId: "auth",
    method: "GET",
    path: "/api/workspace/auth",
    summary: "Прочитать текущую роль",
    description: "Используется shell рабочего пространства до показа персональных разделов.",
    auth: anon,
    request: { contentType: "none", fields: [], example: null },
    success: { status: 200, description: "Состояние конфигурации и текущий actor либо null.", example: { enabled: true, actor: { id: "doctor-demo", displayName: "Дежурный врач", role: "doctor", organizationId: "test-neuro", organizationDisplayName: "Test Neuro", access: doctorAccess } } },
    errors: [error(500, "INTERNAL", "Непредвиденная ошибка чтения состояния.")],
  },
  {
    id: "auth-login",
    groupId: "auth",
    method: "POST",
    path: "/api/workspace/auth",
    summary: "Войти",
    description: "Проверяет учётную запись и устанавливает подписанную HttpOnly cookie на восемь часов.",
    auth: { kind: "conditional", label: "Same-origin + логин", detail: "Успешный ответ устанавливает cookie; пароль не сохраняется в браузерном состоянии." },
    request: { contentType: "application/json", fields: [field("id", "string", true, "Идентификатор учётной записи."), field("password", "string", true, "Пароль; в документации только placeholder.")], example: { id: "doctor-demo", password: "<password>" } },
    success: { status: 200, description: "Actor и Set-Cookie.", example: { actor: { id: "doctor-demo", displayName: "Дежурный врач", role: "doctor", organizationId: "test-neuro", organizationDisplayName: "Test Neuro", access: doctorAccess } } },
    errors: [error(400, "BAD_REQUEST", "Форма не соответствует строгой схеме."), error(401, "UNAUTHORIZED", "Учётные данные не подошли."), error(403, "FORBIDDEN", "Origin не совпал."), error(413, "BODY_TOO_LARGE", "Тело превышает 4 KiB."), error(429, "RATE_LIMITED", "Слишком много попыток входа."), error(503, "WORKSPACE_UNAVAILABLE", "Файл аккаунтов или секрет недоступен.")],
  },
  {
    id: "auth-logout",
    groupId: "auth",
    method: "DELETE",
    path: "/api/workspace/auth",
    summary: "Выйти",
    description: "Обнуляет cookie текущего рабочего пространства.",
    auth: { kind: "conditional", label: "Same-origin", detail: "Запрос допустим без активной сессии и остаётся идемпотентным." },
    request: { contentType: "none", fields: [], example: null },
    success: { status: 200, description: "Cookie очищена.", example: { ok: true } },
    errors: [error(403, "FORBIDDEN", "Origin не совпал."), error(503, "WORKSPACE_UNAVAILABLE", "Сервер не может проверить origin.")],
  },
  {
    id: "intakes-list",
    groupId: "intakes",
    method: "GET",
    path: "/api/workspace/intakes",
    summary: "Список опросов врача",
    description: "Owner видит организацию, doctor — только свои записи; analyst персональный слой не получает.",
    auth: workspace,
    request: { contentType: "none", fields: [], example: null },
    success: { status: 200, description: "Новые сначала; результат присутствует только у завершённых сессий.", example: { intakes: [{ sessionId: "a94648da-2d5e-4fe0-9010-72e972733850", createdAt: 1789897200000, status: "completed", deliveryStatus: "sent", referralId: null, result: { urgency: "emergency", source: "rules_only" } }] } },
    errors: workspaceErrors,
  },
  {
    id: "intake-detail",
    groupId: "intakes",
    method: "GET",
    path: "/api/workspace/intakes/{id}",
    summary: "Карточка опроса",
    description: "Возвращает полную врачебную сводку только владельцу записи или owner той же организации.",
    auth: workspace,
    request: { contentType: "none", fields: [field("id", "uuid · path", true, "Идентификатор сессии.")], example: null },
    success: { status: 200, description: "Сессия, доставка, связанное направление и результат.", example: { intake: { sessionId: "a94648da-2d5e-4fe0-9010-72e972733850", createdAt: 1789897200000, status: "completed", deliveryStatus: "sent", referralId: "ref-demo-01", result: { urgency: "emergency", red_flags: [{ code: "chest_pain", emergency: true, evidence: "давящая боль в груди" }] } } } },
    errors: [...workspaceErrors, error(404, "NOT_FOUND", "Запись скрыта или не существует; analyst получает тот же ответ.")],
  },
  {
    id: "referrals-list",
    groupId: "referrals",
    method: "GET",
    path: "/api/referrals",
    summary: "Список направлений",
    description: "Возвращает доступные врачу карточки и принимает по одному фильтру текущего состояния и профиля.",
    auth: workspace,
    request: {
      contentType: "none",
      fields: [
        field("state", "query · journey flow", false, "Одно из: interviewed, specialist_referred, preparing, sent, waiting, scheduled, attended, not_attended."),
        field("profile", "query · string", false, "Один профиль. Пробелы обрезаются, регистр нормализуется по закрытому справочнику; неизвестное непустое значение даёт пустой список."),
      ],
      example: null,
      note: "Каждый фильтр допускается не более одного раза. Повтор state/profile, неизвестный query-параметр или state вне списка возвращает 400 BAD_REQUEST; пустое значение считается отсутствующим фильтром.",
    },
    success: { status: 200, description: "Направления в области текущего actor.", example: { referrals: [{ id: "ref-demo-01", patientLabel: "CASE-NEURO-001", profile: "хирургический", revision: 3, flow: "preparing", scheduledDate: "2026-10-02" }] } },
    errors: [error(400, "BAD_REQUEST", "Query-параметры не прошли строгую проверку."), error(401, "UNAUTHORIZED", "Сессия врача отсутствует или истекла."), error(403, "FORBIDDEN", "Роль не даёт доступа к персональным направлениям."), error(500, "INTERNAL", "Внутренняя ошибка чтения направлений."), error(503, "WORKSPACE_UNAVAILABLE", "Рабочее пространство не настроено или недоступно.")],
  },
  {
    id: "referral-create",
    groupId: "referrals",
    method: "POST",
    path: "/api/referrals",
    summary: "Создать направление",
    description: "Фиксирует профиль из справочника и при необходимости связывает завершённый опрос.",
    auth: workspace,
    request: {
      contentType: "application/json",
      fields: [field("patientLabel", "string", true, "Псевдоним для рабочего списка."), field("profile", "catalogue value", true, "Профиль из закрытого списка."), field("icd10Code", "string | null", false, "Код для аналитики."), field("destinationOrganization", "string | null", false, "Куда планируется госпитализация."), field("sourceSessionId", "uuid | null", false, "Завершённый опрос того же врача."), field("idempotencyKey", "string", true, "Уникальный ключ команды.")],
      example: { patientLabel: "CASE-NEURO-001", profile: "хирургический", icd10Code: "K40.9", destinationOrganization: "Городской стационар", sourceSessionId: "a94648da-2d5e-4fe0-9010-72e972733850", idempotencyKey: "ref-create-demo-01" },
    },
    success: { status: 200, description: "Созданная или идемпотентно повторённая карточка.", example: { referral: { id: "ref-demo-01", patientLabel: "CASE-NEURO-001", profile: "хирургический", revision: 1, flow: "interviewed", sourceSessionId: "a94648da-2d5e-4fe0-9010-72e972733850" } } },
    errors: [...referralErrors, error(400, "SOURCE_SESSION_REQUIRED", "Указанный опрос не принадлежит врачу или недоступен."), error(409, "SOURCE_SESSION_NOT_COMPLETED", "Связанный опрос ещё не завершён.")],
  },
  {
    id: "referral-detail",
    groupId: "referrals",
    method: "GET",
    path: "/api/referrals/{id}",
    summary: "Карточка направления",
    description: "Собирает факты, историю, обследования и вычисленную комплектность на одной ревизии.",
    auth: workspace,
    request: { contentType: "none", fields: [field("id", "string · path", true, "Идентификатор направления.")], example: null },
    success: { status: 200, description: "Полная карточка для врача.", example: { referral: { id: "ref-demo-01", revision: 3, flow: "preparing", completeness: { status: "unknown", catalogueAvailable: false, catalogueValidated: false, evaluatedOn: "2026-09-26", entries: [] } } } },
    errors: [...workspaceErrors, error(404, "NOT_FOUND", "Направление не найдено в доступной области.")],
  },
  {
    id: "referral-event",
    groupId: "referrals",
    method: "POST",
    path: "/api/referrals/{id}/events",
    summary: "Подтвердить изменение пути",
    description: "Добавляет аудируемое врачебное событие; сервер требует ожидаемую ревизию и причину коррекции.",
    auth: workspace,
    request: { contentType: "application/json", fields: [field("expectedRevision", "integer", true, "Текущая revision карточки."), field("idempotencyKey", "string", true, "Ключ команды."), field("patch", "ReferralFacts patch", true, "Только разрешённые факты пути."), field("reason", "string | null", false, "Причина ручной коррекции."), field("occurredAt", "unix ms | null", false, "Когда событие произошло фактически.")], example: { expectedRevision: 3, idempotencyKey: "event-demo-04", patch: { specialistReferred: true, preparationStarted: true }, reason: "Подтверждено врачом", occurredAt: 1789897800000 } },
    success: { status: 200, description: "Карточка с новой ревизией и событием.", example: { referral: { id: "ref-demo-01", revision: 4, flow: "preparing", updatedAt: 1789897800000 } } },
    errors: [...referralErrors, error(400, "ATTENDANCE_DATE_INVALID", "Явку нельзя подтвердить раньше назначенной даты."), error(400, "REASON_REQUIRED", "Изменение требует объяснения врача."), error(400, "SOURCE_SESSION_REQUIRED", "Этап опроса требует связанной завершённой сессии."), error(409, "REFERRAL_CANCELLED", "Сначала явно возобновите отменённое направление.")],
  },
  {
    id: "referral-examination",
    groupId: "referrals",
    method: "POST",
    path: "/api/referrals/{id}/examinations",
    summary: "Записать обследование",
    description: "Сохраняет наличие, даты и применимость позиции, затем пересчитывает комплектность.",
    auth: workspace,
    request: { contentType: "application/json", fields: [field("expectedRevision", "integer", true, "Текущая revision."), field("idempotencyKey", "string", true, "Ключ команды."), field("record", "ExaminationRecord", true, "Позиция из справочника или врачебная запись."), field("reason", "string | null", false, "Причина исправления."), field("occurredAt", "unix ms | null", false, "Фактическое время.")], example: { expectedRevision: 4, idempotencyKey: "exam-demo-05", record: { requirementId: "cbc", label: "Общий анализ крови", resultAvailable: true, performedOn: "2026-09-24", expiresOn: "2026-10-08", applicability: "yes" }, reason: "Результат получен" } },
    success: { status: 200, description: "Обновлённая карточка с новой комплектностью.", example: { referral: { id: "ref-demo-01", revision: 5, completeness: { status: "unknown", catalogueValidated: false, entries: [{ requirementId: "cbc", label: "Общий анализ крови", required: true, status: "present", expiresOn: "2026-10-08" }] } } } },
    errors: [...referralErrors, error(409, "DUPLICATE_EXAMINATION", "Позиция уже существует; исправьте текущую запись.")],
  },
  {
    id: "referral-notify",
    groupId: "referrals",
    method: "POST",
    path: "/api/referrals/{id}/notify",
    summary: "Отправить сводку врачу",
    description: "Доставляет направление и памятку текущему настроенному получателю с защитой от повторной отправки.",
    auth: workspace,
    request: { contentType: "application/json", fields: [field("expectedRevision", "integer", true, "Ревизия, которую врач видит на экране."), field("idempotencyKey", "string 8–128", true, "Ключ одной попытки доставки.")], example: { expectedRevision: 5, idempotencyKey: "notify-demo-06" } },
    success: { status: 200, description: "Telegram подтвердил отправку.", example: { sent: true } },
    errors: [...referralErrors, error(409, "DELIVERY_UNCONFIRMED", "Предыдущая попытка имеет неопределённый исход; сначала проверьте чат."), error(503, "DELIVERY_RECIPIENT_UNAVAILABLE", "У врача нет доступного chat id.")],
  },
  {
    id: "patient-memo",
    groupId: "referrals",
    method: "GET",
    path: "/api/referrals/{id}/patient-memo",
    summary: "Получить памятку пациенту",
    description: "По умолчанию отдаёт JSON; query format=pdf возвращает печатный PDF с тем же содержанием.",
    auth: workspace,
    request: { contentType: "none", fields: [field("id", "string · path", true, "Идентификатор направления."), field("format", '"pdf" · query', false, "Запросить application/pdf.")], example: null },
    success: { status: 200, description: "JSON-памятка или PDF attachment.", example: { memo: { patientLabel: "CASE-NEURO-001", scheduledDate: "2026-10-02", destinationOrganization: "Городской стационар", catalogueAvailable: false, items: [{ label: "Общий анализ крови", status: "present", expiresOn: "2026-10-08" }] } } },
    errors: [...workspaceErrors, error(404, "NOT_FOUND", "Направление не найдено."), error(503, "PDF_UNAVAILABLE", "PDF временно не собрался; JSON остаётся доступен.")],
    notes: ["Справочник с validated=false отображается как непроверенный.", "PDF не содержит токенов, cookies или служебных идентификаторов."],
  },
  {
    id: "aggregates",
    groupId: "analytics",
    method: "GET",
    path: "/api/workspace/aggregates",
    summary: "Сводка потока",
    description: "Возвращает только агрегаты. Analyst физически не получает персональные поля и не задаёт произвольные фильтры.",
    auth: workspace,
    request: { contentType: "none", fields: [], example: null, note: "Любая query-строка отклоняется: подавление малых групп контролирует сервер." },
    success: { status: 200, description: "Область доступа и агрегаты организации или собственного потока.", example: { access: { personalRecords: "none", aggregateRecords: "organization", aggregatePrivacy: "thresholded" }, aggregates: { suppressed: false, total: 24, scope: "organization", dataSource: "doctor_confirmed_local_records", forecast: null, groups: [{ flow: "preparing", count: 6, meanObservedDays: 3.2, observedTimeCount: 5 }], perProfile: [], period: { from: "2026-09-01", to: "2026-09-26" } } } },
    errors: [error(400, "BAD_REQUEST", "Query-параметры запрещены."), error(401, "UNAUTHORIZED", "Нет сессии рабочего пространства."), error(503, "WORKSPACE_UNAVAILABLE", "Агрегаты недоступны.")],
    notes: ["forecast: null означает, что проверенный прогноз ещё не подключён.", "При малой группе числовые значения подавляются сервером."],
  },
] as const;

export const flowStories: readonly FlowStory[] = [
  {
    id: "flow-intake",
    index: "A",
    title: "От ссылки до сводки",
    outcome: "Пациент отвечает в защищённой вкладке; врач получает результат независимо от UI пациента.",
    steps: [
      { endpointId: "create-link", label: "Ссылка", detail: "Врач создаёт одноразовый token." },
      { endpointId: "chat-start", label: "Старт", detail: "Сервер выдаёт приветствие и capability-cookie." },
      { endpointId: "chat-turn", label: "Опрос", detail: "Каждый ход возвращает turnsLeft и безопасный статус." },
      { endpointId: "chat-finalize", label: "Сводка", detail: "Финализация идемпотентна; правила имеют приоритет." },
    ],
  },
  {
    id: "flow-referral",
    index: "B",
    title: "От опроса к комплектному направлению",
    outcome: "Врач связывает завершённый опрос, фиксирует обследования и отдаёт пациенту памятку.",
    steps: [
      { endpointId: "intakes-list", label: "Входящие", detail: "Видны только разрешённые опросы." },
      { endpointId: "referral-create", label: "Направление", detail: "Профиль выбирается из закрытого списка." },
      { endpointId: "referral-examination", label: "Комплектность", detail: "Дата и применимость подтверждаются врачом." },
      { endpointId: "patient-memo", label: "Памятка", detail: "JSON и PDF строятся из одной карточки." },
    ],
  },
  {
    id: "flow-oversight",
    index: "D",
    title: "От потока к агрегатам",
    outcome: "Врач работает с собственными пациентами, аналитик получает только обезличенный слой.",
    steps: [
      { endpointId: "auth-login", label: "Роль", detail: "Сессия несёт организацию и роль." },
      { endpointId: "referral-event", label: "Факт", detail: "Каждый переход подтверждён и версионирован." },
      { endpointId: "aggregates", label: "Срез", detail: "Персональные поля не покидают серверный слой." },
    ],
  },
] as const;

function endpointUrl(endpoint: ApiEndpoint): string {
  const path = endpoint.path
    .replace("{id}", "ref-demo-01")
    .replace("/api/workspace/intakes/ref-demo-01", "/api/workspace/intakes/a94648da-2d5e-4fe0-9010-72e972733850");
  return endpoint.id === "referrals-list"
    ? `${path}?state=preparing&profile=${encodeURIComponent("хирургический")}`
    : path;
}

function curlAuth(endpoint: ApiEndpoint, baseUrl: string): string[] {
  if (endpoint.id === "create-link") return ['  --cookie "<workspace-session-cookie>" \\\n'];
  if (endpoint.auth.kind === "workspace") return ['  --cookie "<workspace-session-cookie>" \\\n'];
  if (endpoint.auth.kind === "patient") return ['  --cookie "<patient-capability-cookie>" \\\n', `  -H "Origin: ${baseUrl}" \\\n`];
  if (endpoint.id === "chat-start" || endpoint.id === "auth-login" || endpoint.id === "auth-logout") {
    return [`  -H "Origin: ${baseUrl}" \\\n`];
  }
  return [];
}

export function codeExample(endpoint: ApiEndpoint, language: CodeLanguage, baseUrl = "http://localhost:3000"): string {
  const origin = baseUrl.replace(/\/$/u, "");
  const url = `${origin}${endpointUrl(endpoint)}`;
  const body = endpoint.request.example === null ? null : JSON.stringify(endpoint.request.example, null, 2);
  if (language === "curl") {
    const lines = [`curl --request ${endpoint.method} \\\n`, `  --url "${url}" \\\n`, ...curlAuth(endpoint, origin)];
    if (body !== null) {
      lines.push('  -H "Content-Type: application/json" \\\n');
      lines.push(`  --data '${body}'`);
    } else {
      lines[lines.length - 1] = lines[lines.length - 1].replace(/ \\\n$/u, "");
    }
    return lines.join("");
  }

  const options = [
    `  method: "${endpoint.method}",`,
    ...(endpoint.auth.kind !== "public" ? ['  credentials: "include",'] : []),
    ...(body !== null ? ['  headers: { "Content-Type": "application/json" },', `  body: JSON.stringify(${body.replace(/\n/gu, "\n  ")}),`] : []),
  ];
  return `const response = await fetch("${endpointUrl(endpoint)}", {\n${options.join("\n")}\n});\n\nif (!response.ok) {\n  const problem = await response.json();\n  throw new Error(problem.code ?? "REQUEST_FAILED");\n}\n\nconst data = await response.${endpoint.id === "patient-memo" ? "json() // use blob() with ?format=pdf" : "json()"};`;
}

export function endpointOperation(endpoint: Pick<ApiEndpoint, "method" | "path">): string {
  return `${endpoint.method} ${endpoint.path}`;
}
