export type ApiMethod = "GET" | "POST" | "DELETE";
export type ApiGroupId = "system" | "patient" | "auth" | "intakes" | "referrals" | "analytics" | "models" | "reference" | "mis";
export type CodeLanguage = "curl" | "fetch";

export interface ApiField {
  name: string;
  type: string;
  required: boolean;
  description: string;
  location?: "path" | "query" | "header" | "body";
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
    kind: "public" | "conditional" | "patient" | "workspace" | "service";
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
    contentTypes?: readonly string[];
  };
  errors: readonly ApiErrorSpec[];
  notes?: readonly string[];
  roles?: readonly ("owner" | "doctor" | "analyst")[];
  pathExample?: Readonly<Record<string, string>>;
  strictQuery?: boolean;
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

const field = (name: string, type: string, required: boolean, description: string, location?: ApiField["location"]): ApiField => ({
  name, type, required, description, ...(location ? { location } : {}),
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
  error(500, "INTERNAL", "Внутренняя ошибка обработки запроса."),
  error(503, "WORKSPACE_UNAVAILABLE", "Рабочее пространство не настроено или недоступно."),
] as const;

const referralErrors = [
  ...workspaceErrors,
  error(404, "NOT_FOUND", "Запись не найдена в доступной области."),
  error(409, "REVISION_CONFLICT", "Карточка уже изменилась; загрузите свежую ревизию."),
  error(409, "IDEMPOTENCY_CONFLICT", "Ключ уже применён к другому изменению."),
] as const;

const modelEvidenceErrors = [
  error(401, "UNAUTHORIZED", "Сессия рабочего пространства отсутствует или истекла."),
  error(503, "WORKSPACE_UNAVAILABLE", "Рабочее пространство не настроено или недоступно."),
  error(503, "MODEL_EVIDENCE_UNAVAILABLE", "Проверенный агрегированный отчёт отсутствует или не прошёл fail-closed проверку."),
] as const;

const referenceErrors = [
  error(401, "UNAUTHORIZED", "Сессия рабочего пространства отсутствует или истекла."),
  error(405, "METHOD_NOT_ALLOWED", "Справочник доступен только для чтения методом GET."),
  error(503, "WORKSPACE_UNAVAILABLE", "Рабочее пространство или справочник обследований недоступны."),
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
  {
    id: "models",
    eyebrow: "06 · Research",
    title: "Модели и доказательства",
    description: "Версионированные карточки runtime и research-only контуров с метриками, ограничениями и честными пустыми значениями.",
  },
  {
    id: "reference",
    eyebrow: "07 · Reference",
    title: "Справочник обследований",
    description: "Read-only контракт B1: профили госпитализации, требования приложения 5, сроки актуальности и статус врачебной проверки.",
  },
  {
    id: "mis",
    eyebrow: "08 · Integration",
    title: "МИС",
    description: "Организационно ограниченная очередь событий с отдельной service credential, lease и ACK.",
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
const service = {
  kind: "service",
  label: "MIS bearer credential",
  detail: "Отдельный service credential с организацией и scope; browser cookie не принимается.",
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
    request: { contentType: "none", fields: [
      field("probe", '"extract"', false, "Опциональная глубокая проверка; может выполнить один платный вызов только при корректном proof.", "query"),
      field("x-demeu-health-proof", "hex HMAC", false, "Требуется для probe=extract во внешнем LLM режиме; вычисляется из ключа и commit.", "header"),
    ], example: null, note: "Опциональный probe=extract защищён доказательством и не предназначен для частого polling." },
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
    roles: ["doctor"],
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
    auth: { kind: "conditional", label: "Cookie опциональна", detail: "Без cookie actor равен null; с workspace-cookie возвращается текущая роль и область доступа." },
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
    roles: ["owner", "doctor"],
    request: { contentType: "none", fields: [], example: null },
    success: { status: 200, description: "Новые сначала; результат присутствует только у завершённых сессий.", example: { intakes: [{ sessionId: "a94648da-2d5e-4fe0-9010-72e972733850", createdAt: 1789897200000, status: "completed", deliveryStatus: "sent", referralId: null, result: { urgency: "emergency", source: "rules_only" } }] } },
    errors: [error(401, "UNAUTHORIZED", "Сессия врача отсутствует или истекла."), error(403, "FORBIDDEN", "Analyst не получает персональный список."), error(500, "INTERNAL", "Внутренняя ошибка чтения."), error(503, "WORKSPACE_UNAVAILABLE", "Рабочее пространство недоступно.")],
  },
  {
    id: "intake-detail",
    groupId: "intakes",
    method: "GET",
    path: "/api/workspace/intakes/{id}",
    summary: "Карточка опроса",
    description: "Возвращает полную врачебную сводку только владельцу записи или owner той же организации.",
    auth: workspace,
    roles: ["owner", "doctor"],
    request: { contentType: "none", fields: [field("id", "uuid · path", true, "Идентификатор сессии.")], example: null },
    success: { status: 200, description: "Сессия, доставка, связанное направление и результат.", example: { intake: { sessionId: "a94648da-2d5e-4fe0-9010-72e972733850", createdAt: 1789897200000, status: "completed", deliveryStatus: "sent", referralId: "ref-demo-01", result: { urgency: "emergency", red_flags: [{ code: "chest_pain", emergency: true, evidence: "давящая боль в груди" }] } } } },
    errors: [error(401, "UNAUTHORIZED", "Сессия врача отсутствует или истекла."), error(404, "NOT_FOUND", "Запись скрыта или не существует; analyst получает тот же ответ."), error(500, "INTERNAL", "Внутренняя ошибка чтения."), error(503, "WORKSPACE_UNAVAILABLE", "Рабочее пространство недоступно.")],
  },
  {
    id: "referrals-list",
    strictQuery: true,
    groupId: "referrals",
    method: "GET",
    path: "/api/referrals",
    summary: "Список направлений",
    description: "Возвращает доступные врачу карточки и принимает по одному фильтру текущего состояния и профиля.",
    auth: workspace,
    roles: ["owner", "doctor"],
    request: {
      contentType: "none",
      fields: [
        field("state", "query · journey flow", false, "Одно из: interviewed, specialist_referred, preparing, sent, waiting, scheduled, attended, not_attended.", "query"),
        field("profile", "query · string", false, "Один профиль. Пробелы обрезаются, регистр нормализуется по закрытому справочнику; неизвестное непустое значение даёт пустой список.", "query"),
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
    roles: ["owner", "doctor"],
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
    roles: ["owner", "doctor"],
    request: { contentType: "none", fields: [field("id", "string · path", true, "Идентификатор направления.")], example: null },
    success: { status: 200, description: "Полная карточка для врача.", example: { referral: { id: "ref-demo-01", revision: 3, flow: "preparing", completeness: { status: "unknown", catalogueAvailable: false, catalogueValidated: false, evaluatedOn: "2026-09-26", entries: [] } } } },
    errors: [error(401, "UNAUTHORIZED", "Сессия врача отсутствует или истекла."), error(403, "FORBIDDEN", "Analyst не получает персональную карточку."), error(404, "NOT_FOUND", "Направление не найдено в доступной области."), error(500, "INTERNAL", "Внутренняя ошибка чтения."), error(503, "WORKSPACE_UNAVAILABLE", "Рабочее пространство недоступно.")],
  },
  {
    id: "referral-event",
    groupId: "referrals",
    method: "POST",
    path: "/api/referrals/{id}/events",
    summary: "Подтвердить изменение пути",
    description: "Добавляет аудируемое врачебное событие; сервер требует ожидаемую ревизию и причину коррекции.",
    auth: workspace,
    roles: ["owner", "doctor"],
    request: { contentType: "application/json", fields: [field("expectedRevision", "integer", true, "Текущая revision карточки."), field("idempotencyKey", "string", true, "Ключ команды."), field("patch", "ReferralFacts patch", true, "Только разрешённые факты пути."), field("reason", "string | null", false, "Причина ручной коррекции."), field("occurredAt", "unix ms | null", false, "Когда событие произошло фактически.")], example: { expectedRevision: 3, idempotencyKey: "event-demo-04", patch: { specialistReferred: true, preparationStarted: true }, reason: "Подтверждено врачом", occurredAt: 1789897800000 } },
    success: { status: 200, description: "Карточка с новой ревизией и событием.", example: { referral: { id: "ref-demo-01", revision: 4, flow: "preparing", updatedAt: 1789897800000 } } },
    errors: [...referralErrors, error(400, "ATTENDANCE_DATE_INVALID", "Явку нельзя подтвердить раньше назначенной даты."), error(400, "REASON_REQUIRED", "Изменение требует объяснения врача."), error(400, "SOURCE_SESSION_REQUIRED", "Этап опроса требует связанной завершённой сессии."), error(409, "NO_CHANGES", "Подтверждённые факты не изменились."), error(409, "REFERRAL_CANCELLED", "Сначала явно возобновите отменённое направление.")],
  },
  {
    id: "referral-examination",
    groupId: "referrals",
    method: "POST",
    path: "/api/referrals/{id}/examinations",
    summary: "Записать обследование",
    description: "Сохраняет наличие, даты и применимость позиции, затем пересчитывает комплектность.",
    auth: workspace,
    roles: ["owner", "doctor"],
    request: { contentType: "application/json", fields: [field("expectedRevision", "integer", true, "Текущая revision."), field("idempotencyKey", "string", true, "Ключ команды."), field("record", "ExaminationRecord", true, "Позиция из справочника или врачебная запись."), field("reason", "string | null", false, "Причина исправления."), field("occurredAt", "unix ms | null", false, "Фактическое время.")], example: { expectedRevision: 4, idempotencyKey: "exam-demo-05", record: { requirementId: "cbc", label: "Общий анализ крови", resultAvailable: true, performedOn: "2026-09-24", expiresOn: "2026-10-08", applicability: "yes" }, reason: "Результат получен" } },
    success: { status: 200, description: "Обновлённая карточка с новой комплектностью.", example: { referral: { id: "ref-demo-01", revision: 5, completeness: { status: "unknown", catalogueValidated: false, entries: [{ requirementId: "cbc", label: "Общий анализ крови", required: true, status: "present", expiresOn: "2026-10-08" }] } } } },
    errors: [...referralErrors, error(400, "REASON_REQUIRED", "Для исправления позиции нужна причина."), error(409, "PACKAGE_CHANGED", "Снимок пакета изменился."), error(409, "DUPLICATE_EXAMINATION", "Позиция уже существует; исправьте текущую запись.")],
  },
  {
    id: "referral-notify",
    groupId: "referrals",
    method: "POST",
    path: "/api/referrals/{id}/notify",
    summary: "Отправить сводку врачу",
    description: "Доставляет направление и памятку текущему настроенному получателю с защитой от повторной отправки.",
    auth: workspace,
    roles: ["owner", "doctor"],
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
    roles: ["owner", "doctor"],
    request: { contentType: "none", fields: [field("id", "string · path", true, "Идентификатор направления.", "path"), field("format", "string · query", false, "Значение pdf запрашивает application/pdf; другие значения сохраняют legacy JSON-ответ.", "query")], example: null,
      note: "Legacy handler permissive: неизвестные и повторные query-параметры не отклоняются; формат выбирается по первому format=pdf." },
    success: { status: 200, description: "JSON-памятка или PDF attachment.", contentTypes: ["application/json", "application/pdf"], example: { memo: { patientLabel: "CASE-NEURO-001", scheduledDate: "2026-10-02", destinationOrganization: "Городской стационар", catalogueAvailable: false, items: [{ label: "Общий анализ крови", status: "present", expiresOn: "2026-10-08" }] } } },
    errors: [error(401, "UNAUTHORIZED", "Сессия врача отсутствует или истекла."), error(403, "FORBIDDEN", "Analyst не получает персональную памятку."), error(404, "NOT_FOUND", "Направление не найдено."), error(500, "INTERNAL", "Внутренняя ошибка чтения."), error(503, "WORKSPACE_UNAVAILABLE", "Рабочее пространство недоступно."), error(503, "PDF_UNAVAILABLE", "PDF временно не собрался; JSON остаётся доступен.")],
    notes: ["Справочник с validated=false отображается как непроверенный.", "PDF не содержит токенов, cookies или служебных идентификаторов."],
  },
  {
    id: "aggregates",
    strictQuery: true,
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
  {
    id: "models-list",
    groupId: "models",
    method: "GET",
    path: "/api/models",
    summary: "Каталог моделей",
    description: "Возвращает компактные карточки runtime LR, safety-правил, Qwen/Jev и задач D1, B3, D2 без весов, строк датасета и персональных данных.",
    auth: workspace,
    request: { contentType: "none", fields: [], example: null, note: "Параметров и тела нет. Owner, doctor и analyst получают один агрегированный исследовательский контракт." },
    success: {
      status: 200,
      description: "Версионированный список карточек с основной метрикой, baseline и ограничениями.",
      example: {
        schemaVersion: 1,
        models: [{
          id: "triage-lr-v1",
          taskId: "A",
          title: "Модель предварительной гипотезы и маршрутизации",
          kind: "runtime_classifier",
          availability: "runtime",
          runtimeActivation: "active",
          researchOnly: false,
          metricStatus: "measured",
          primaryMetric: { name: "pathology_top1", value: 1, unit: "fraction", state: "measured", reason: null, period: null, rows: 40, numerator: 40, denominator: 40 },
          baseline: null,
          limitations: ["top-1 измерен в режиме no-llm; языковой адаптер не участвовал."],
          detailPath: "/api/models/triage-lr-v1",
        }],
      },
    },
    errors: modelEvidenceErrors,
    notes: [
      "Карточка описывает измеренное состояние артефакта, а не запускает inference.",
      "researchOnly=true запрещает трактовать контур как подключённый к решениям по пациенту.",
      "primaryMetric или baseline равны null, когда честного измерения нет; нулём отсутствие данных не подменяется.",
    ],
  },
  {
    id: "models-benchmarks",
    groupId: "models",
    method: "GET",
    path: "/api/models/benchmarks",
    summary: "Сравнение safety-кандидатов",
    description: "Отдаёт единый агрегированный RU/KK benchmark правил, Qwen и Jev с одинаковой выборкой, статусом доступности и оговорками методологии.",
    auth: workspace,
    request: { contentType: "none", fields: [], example: null, note: "Параметров и тела нет. Endpoint возвращает только замороженный red-flag benchmark." },
    success: {
      status: 200,
      description: "Сравнимые метрики кандидатов; отсутствующие измерения остаются null.",
      example: {
        schemaVersion: 1,
        benchmark: {
          id: "redflags-ru-kk-v1",
          title: "Synthetic RU/KK emergency regression benchmark",
          researchOnly: true,
          runtimeIntegration: "deterministic_rules_only",
          corpus: { itemCount: 160, languageCounts: { ru: 80, kk: 80 }, classCounts: { positive: 80, negative: 80 }, sha256: "bafae774a648ccde988b4804a02d0d0adce983d7d979e6fcefcf230902ac5625", frozenOn: "2026-09-26" },
          evaluationDesign: { sameFrozenSplit: true, rulesDevelopedAgainstCorpus: true, unseenGeneralizationClaim: false },
          candidates: [{
            modelId: "redflags-jev-1.13",
            implementation: { kind: "external_candidate", provider: "Convex", requestedModel: "typesafe/jev-1.13", observedModel: "typesafe/jev-1.13-20260917", threshold: 0.5, questionSpecId: "redflags-eight-trigger-v1" },
            availability: "measured",
            itemCount: 160,
            metrics: { tp: 79, fp: 0, tn: 80, fn: 1, precision: 1, recall: 0.9875, f1: 0.9937106918238994, falsePositiveRate: 0 },
            slices: { "language:ru": { tp: 39, fp: 0, tn: 40, fn: 1, precision: 1, recall: 0.975, f1: 0.9873417721518987, falsePositiveRate: 0 }, "language:kk": { tp: 40, fp: 0, tn: 40, fn: 0, precision: 1, recall: 1, f1: 1, falsePositiveRate: 0 }, "trigger:suicidal": { tp: 10, fp: 0, tn: 10, fn: 0, precision: 1, recall: 1, f1: 1, falsePositiveRate: 0 }, "trigger:consciousness": { tp: 9, fp: 0, tn: 10, fn: 1, precision: 1, recall: 0.9, f1: 0.9473684210526316, falsePositiveRate: 0 } },
            latency: { measurementUnit: "wall_clock_per_batch_of_up_to_10", requestCount: 16, totalMs: 3042, meanMs: 190.125, p50Ms: 182, p95Ms: 260, scope: "Convex action wall-clock around accepted Decisions requests; deployment invocation overhead excluded." },
            cost: { currency: "USD", amount: 0.001810746, basis: "usage.cost returned by Convex AI Gateway for all accepted requests; Convex action platform usage excluded.", coverage: 1, inputTokens: 43113, outputTokens: 3264 },
            structuredOutput: { logicalBatchCount: 16, acceptedRequestCount: 16, rejectedResponseCount: 0, inputTokens: 43113, outputTokens: 3264 },
            unavailableReason: null,
          }],
          limitations: ["Синтетическая выборка не является независимой клинической валидацией."],
        },
      },
    },
    errors: modelEvidenceErrors,
    notes: [
      "Jev измерен одним zero-shot research-only прогоном через alpha endpoint без seed; результат не активирован в runtime и не является независимой клинической валидацией.",
      "Один пропуск Jev находится в slice trigger:consciousness (TP 9, FN 1, recall 0.9); исходная фраза пациента через API не публикуется.",
      "Корпус, восемь групп признаков, labels и threshold 0.5 одинаковы, но правила дорабатывались на этом корпусе, поэтому их результат остаётся in-sample.",
      "Latency Jev измерена на batch до 10 случаев и напрямую не сравнима с per-item/per-request latency других кандидатов.",
      "Если кандидат недоступен, metrics, slices, latency и cost остаются null, а причина передаётся отдельно.",
      "Результат усиленных правил — in-sample regression coverage, не unseen generalization.",
      "Кандидаты Qwen и Jev являются research-only и не подключены к runtime.",
    ],
  },
  {
    id: "model-detail",
    groupId: "models",
    method: "GET",
    path: "/api/models/{id}",
    summary: "Карточка модели",
    description: "Возвращает allowlisted provenance, схему оценки, метрики, baselines и ограничения одного контура без внутренних весов и сырых наблюдений.",
    auth: workspace,
    request: { contentType: "none", fields: [field("id", "stable model id · path", true, "Идентификатор из GET /api/models.")], example: null, note: "Параметров query и тела нет; используйте только detailPath из каталога." },
    success: {
      status: 200,
      description: "Подробная карточка с тем же базовым контрактом, что в каталоге.",
      example: {
        schemaVersion: 1,
        model: {
          id: "d2-laboratory-load-v0",
          taskId: "D2",
          title: "D2: нагрузка лабораторий",
          kind: "blocked_forecast",
          availability: "unavailable",
          runtimeActivation: "blocked",
          researchOnly: true,
          metricStatus: "unavailable",
          primaryMetric: { name: "mae", value: null, unit: "units", state: "unavailable", reason: "no_observed_laboratory_target", period: null, rows: null, numerator: null, denominator: null },
          baseline: null,
          limitations: ["appendix_5_requirements_are_normative_not_observed_demand"],
          detailPath: "/api/models/d2-laboratory-load-v0",
          source: { artifacts: [{ path: "reports/lab-load-v1.json", sha256: null }], dataset: { name: "Ashyq Data referral flow only", period: { from: "2025-01", to: "2025-03" }, rows: 767130, licenseStatus: "not_verified" } },
          evaluation: { design: "not_executed_missing_observed_laboratory_target", split: null, sampleSize: null, metrics: [{ name: "mae", value: null, unit: "units", state: "unavailable", reason: "no_observed_laboratory_target", period: null, rows: null, numerator: null, denominator: null }], baselines: [], slices: null, caveats: ["no_observed_laboratory_target"] },
          configuration: { nextDataGate: { minimum_history: "at_least_26_contiguous_weeks_for_weekly_seasonality", preferred_history: "at_least_24_months_for_annual_seasonality" } },
          unavailable: { code: "MISSING_LABORATORY_DEMAND_TARGET", reason: "no_observed_laboratory_target", requiredInputs: ["event_timestamp", "region_or_performing_organization", "examination_code", "observed_unit_count_or_one_row_per_event", "event_status_or_stage"] },
        },
      },
    },
    errors: [...modelEvidenceErrors, error(404, "NOT_FOUND", "Модель или исследовательский контур с таким id отсутствует.")],
    notes: [
      "Detail не содержит predictions, весов, feature/class order, сырых строк и абсолютных путей.",
      "B3 имеет отдельный research-only per-referral runtime endpoint по неизменяемым подтверждённым входам и не влияет на клинические или операционные решения; карточки D1/D2 публикуют только агрегированный статус.",
      "Для blocked/unavailable контуров отсутствие метрики представлено null вместе с причиной и требуемыми входами.",
    ],
  },
  {
    id: "examination-requirements-reference",
    strictQuery: true,
    groupId: "reference",
    method: "GET",
    path: "/api/reference/examination-requirements",
    summary: "Прочитать требования к обследованиям",
    description: "Возвращает версионированный справочник B1 по восьми профилям госпитализации вместе со статусом врачебной проверки и контрольными количествами.",
    auth: workspace,
    request: {
      contentType: "none",
      fields: [],
      example: null,
      note: "Параметров и тела нет. Любая query-строка отклоняется; owner, doctor и analyst читают один нормативный справочник.",
    },
    success: {
      status: 200,
      description: "Справочник приложения 5: 8 профилей, 148 развёрнутых позиций и 57 уникальных кодов.",
      example: {
        schemaVersion: 1,
        catalogue: {
          id: "b1-examination-requirements-v1",
          version: "2025-02-17-order-9-appendix-5",
          status: "available",
          source: "Приложение 5 к Стандарту организации оказания медицинской помощи в стационарных условиях в РК (приказ МЗ РК от 24.03.2022 № ҚР-ДСМ-27, рег. № 27218), в редакции приказа МЗ РК от 17.02.2025 № 9. Пункт 33 Стандарта. Взрослые пациенты, оперативное лечение.",
          scope: { population: "adult", careSetting: "inpatient", treatment: "operative" },
          validated: false,
          validationStatus: "unvalidated",
        },
        summary: { profileCount: 8, requirementOccurrenceCount: 148, uniqueRequirementCount: 57 },
        profiles: [{
          profile: "Кардиохирургический",
          requirements: [
            { id: "cbc", label: "Общий анализ крови (развернутый)", required: true, conditional: false, validForDays: 14 },
            { id: "card_coronary_angio", label: "Коронарная ангиография (CD с результатами)", required: false, conditional: true, validForDays: null },
          ],
        }],
      },
    },
    errors: [
      error(400, "BAD_REQUEST", "Query-параметры запрещены."),
      ...referenceErrors,
      error(503, "REFERENCE_CATALOGUE_UNAVAILABLE", "Справочник повреждён, неполон или не прошёл fail-closed проверку."),
    ],
    notes: [
      "Ответ имеет Cache-Control: no-store и не содержит данных пациентов, учётных записей или секретов.",
      "validated=false и validationStatus=unvalidated означают, что справочник ещё не проверен врачом больницы.",
      "validForDays=null означает, что источник не задаёт срок актуальности; это не ноль дней и не утверждение о бессрочности.",
      "Полный ответ содержит все восемь профилей; success example показывает структуру и оба варианта validForDays.",
    ],
  },
  {
    id: "chat-preparation",
    groupId: "patient",
    method: "POST",
    path: "/api/chat/preparation",
    summary: "Получить доступ к подготовке",
    description: "Для защищённой сессии создаёт или возвращает узкую ссылку на пакет подготовки пациента.",
    auth: patient,
    request: { contentType: "application/json", fields: [field("sessionId", "uuid", true, "Идентификатор защищённой сессии.")], example: { sessionId: "a94648da-2d5e-4fe0-9010-72e972733850" } },
    success: { status: 200, description: "Сессия связана с подготовкой либо пакет ещё ожидает направления.", example: { sessionId: "a94648da-2d5e-4fe0-9010-72e972733850", preparationPending: true } },
    errors: [error(400, "BAD_REQUEST", "Тело не прошло строгую проверку."), error(401, "UNAUTHORIZED", "Capability-cookie недействительна."), error(403, "FORBIDDEN", "Origin не совпал."), error(404, "SESSION_NOT_FOUND", "Сессия не найдена."), error(413, "BODY_TOO_LARGE", "Тело превышает предел."), error(500, "INTERNAL", "Внутренняя ошибка."), error(503, "WORKSPACE_UNAVAILABLE", "Рабочее пространство недоступно.")],
  },
  {
    id: "patient-access",
    strictQuery: true,
    groupId: "patient",
    method: "POST",
    path: "/api/patient/access",
    summary: "Активировать ссылку подготовки",
    description: "Обменивает одноразовый токен подготовки на узкую HttpOnly cookie одного эпизода.",
    auth: { kind: "conditional", label: "Токен подготовки + same-origin", detail: "Токен передаётся один раз; ответ устанавливает динамическую capability-cookie." },
    request: { contentType: "application/json", fields: [field("token", "opaque token", true, "Токен из персональной ссылки.")], example: { token: "<preparation-token>" } },
    success: { status: 200, description: "Безопасный пакет подготовки.", example: { package: { accessId: "prep-demo-01", state: "preparing", catalogueValidated: false, catalogueAvailable: false, confirmedCompleteness: "unknown", items: [] } } },
    errors: [error(400, "BAD_REQUEST", "Тело или токен неверны."), error(401, "UNAUTHORIZED", "Токен недействителен или истёк."), error(403, "FORBIDDEN", "Origin не совпал."), error(413, "BODY_TOO_LARGE", "Тело превышает предел."), error(503, "WORKSPACE_UNAVAILABLE", "Хранилище недоступно.")],
  },
  {
    id: "patient-discover",
    strictQuery: true,
    groupId: "patient",
    method: "POST",
    path: "/api/patient/discover",
    summary: "Найти ранее активированный пакет",
    description: "Находит пакет только при совпадении исходной ссылки и уже выданной capability-cookie.",
    auth: patient,
    request: { contentType: "application/json", fields: [field("token", "16 hex chars", true, "Исходный токен ссылки.")], example: { token: "7fa31c2b940e4a71" } },
    success: { status: 200, description: "Тот же безопасный пакет эпизода.", example: { package: { accessId: "prep-demo-01", state: "preparing", catalogueValidated: false, confirmedCompleteness: "unknown", items: [] } } },
    errors: [error(400, "BAD_REQUEST", "Тело неверно."), error(401, "UNAUTHORIZED", "Ссылка или cookie не совпали."), error(403, "FORBIDDEN", "Origin не совпал."), error(413, "BODY_TOO_LARGE", "Тело превышает предел."), error(503, "WORKSPACE_UNAVAILABLE", "Хранилище недоступно.")],
  },
  {
    id: "patient-package-read",
    strictQuery: true,
    groupId: "patient",
    method: "GET",
    path: "/api/patient/{id}/package",
    summary: "Прочитать пакет подготовки",
    description: "Возвращает whitelist JSON либо PDF без врачебной гипотезы, вероятностей, маршрутизации и внутренних полей.",
    auth: patient,
    request: { contentType: "none", fields: [field("id", "preparation access id", true, "Идентификатор доступа.", "path"), field("format", '"pdf"', false, "Формат PDF.", "query"), field("lang", '"ru" | "kk"', false, "Язык PDF; допустим только вместе с format=pdf.", "query")], example: null },
    success: { status: 200, description: "JSON-пакет или PDF.", contentTypes: ["application/json", "application/pdf"], example: { package: { accessId: "prep-demo-01", state: "preparing", catalogueValidated: false, confirmedCompleteness: "unknown", items: [] } } },
    errors: [error(400, "BAD_REQUEST", "Query не соответствует строгой схеме."), error(401, "UNAUTHORIZED", "Cookie доступа отсутствует или истекла."), error(403, "FORBIDDEN", "Cross-site чтение отклонено."), error(503, "INTERNAL", "Пакет или PDF временно недоступен.")],
    pathExample: { id: "prep-demo-01" },
  },
  {
    id: "patient-package-report",
    strictQuery: true,
    groupId: "patient",
    method: "POST",
    path: "/api/patient/{id}/package",
    summary: "Сохранить отметку пациента",
    description: "Сохраняет self-report отдельно от врачебного подтверждения; он не делает пакет проверенно комплектным.",
    auth: patient,
    request: { contentType: "application/json", fields: [field("id", "preparation access id", true, "Идентификатор доступа.", "path"), field("requirementId", "string", true, "Позиция активного снимка."), field("performedOn", "YYYY-MM-DD", true, "Дата со слов пациента."), field("resultAvailable", "boolean", true, "Есть ли результат."), field("expectedRevision", "integer", true, "Версия отметки."), field("idempotencyKey", "string", true, "Ключ повтора.")], example: { requirementId: "cbc", performedOn: "2026-10-01", resultAvailable: true, expectedRevision: 0, idempotencyKey: "patient-report-demo-01" } },
    success: { status: 200, description: "Пакет с отдельной неподтверждённой отметкой.", example: { package: { accessId: "prep-demo-01", state: "preparing", confirmedCompleteness: "unknown", items: [{ requirementId: "cbc", preparationStatus: "present", confirmedStatus: "unknown", selfReport: { performedOn: "2026-10-01", resultAvailable: true, confirmed: false } }] } } },
    errors: [error(400, "BAD_REQUEST", "Тело неверно."), error(401, "UNAUTHORIZED", "Cookie недействительна."), error(403, "FORBIDDEN", "Origin не совпал."), error(404, "NOT_FOUND", "Позиция не найдена."), error(409, "REVISION_CONFLICT", "Отметка изменилась."), error(409, "IDEMPOTENCY_CONFLICT", "Ключ связан с другим телом."), error(409, "APPLICABILITY_UNCONFIRMED", "Применимость условной позиции не подтверждена."), error(409, "NO_CHANGES", "Такая отметка уже сохранена."), error(409, "PACKAGE_UNAVAILABLE", "Активного пакета нет."), error(413, "BODY_TOO_LARGE", "Тело превышает предел."), error(429, "RATE_LIMIT", "Лимит изменений превышен."), error(429, "REPORT_LIMIT", "Лимит истории превышен."), error(503, "INTERNAL", "Хранилище недоступно.")],
    pathExample: { id: "prep-demo-01" },
  },
  {
    id: "case1-analytics",
    strictQuery: true,
    groupId: "analytics",
    method: "GET",
    path: "/api/analytics/case1",
    summary: "Прочитать Case 1",
    description: "Возвращает проверенный агрегированный артефакт Case 1 без персональных строк и синтетических сравнений.",
    auth: workspace,
    roles: ["owner", "analyst"],
    request: { contentType: "none", fields: [], example: null, note: "Query и body запрещены." },
    success: { status: 200, description: "Семь агрегированных блоков с provenance и ограничениями.", example: { schemaVersion: 1, provenance: { source: "reports/case1-analytics.json", limitations: ["Агрегированные наблюдаемые данные."] }, blocks: [] } },
    errors: [error(400, "BAD_REQUEST", "Query запрещён."), error(401, "UNAUTHORIZED", "Сессия отсутствует."), error(403, "FORBIDDEN", "Роль врача не имеет доступа."), error(405, "METHOD_NOT_ALLOWED", "Поддерживается только GET."), error(503, "CASE1_ANALYTICS_UNAVAILABLE", "Артефакт не прошёл проверку."), error(503, "WORKSPACE_UNAVAILABLE", "Рабочее пространство недоступно.")],
  },
  {
    id: "doctor-assessment",
    strictQuery: true,
    groupId: "referrals",
    method: "POST",
    path: "/api/referrals/{id}/doctor-assessment",
    summary: "Сохранить заключение врача",
    description: "Назначенный врач сохраняет аудитируемую предварительную гипотезу, профиль, код МКБ-10 и контекст лечения.",
    auth: workspace,
    roles: ["doctor"],
    request: { contentType: "application/json", fields: [field("id", "referral id", true, "Направление.", "path"), field("expectedRevision", "integer", true, "Версия карточки."), field("expectedAssessmentRevision", "integer", true, "Версия заключения."), field("idempotencyKey", "string", true, "Ключ повтора."), field("reason", "string", true, "Причина изменения."), field("assessment", "object", true, "hypothesis, profile, icd10Code, careContext.")], example: { expectedRevision: 3, expectedAssessmentRevision: 0, idempotencyKey: "assessment-demo-01", reason: "Проверено врачом", assessment: { hypothesis: "Предварительная сосудистая гипотеза", profile: "Сосудистая хирургия", icd10Code: "I65.2", careContext: "operative" } } },
    success: { status: 200, description: "Обновлённая карточка с неизменным triage snapshot.", example: { referral: { id: "ref-demo-01", revision: 4, profile: "Сосудистая хирургия", icd10Code: "I65.2", doctorAssessment: { hypothesis: "Предварительная сосудистая гипотеза", careContext: "operative", revision: 1 } } } },
    errors: [...referralErrors, error(400, "REASON_REQUIRED", "Причина обязательна."), error(409, "ASSESSMENT_REVISION_CONFLICT", "Заключение изменилось."), error(409, "NO_CHANGES", "Изменений нет.")],
    pathExample: { id: "ref-demo-01" },
  },
  {
    id: "preparation-status",
    groupId: "referrals",
    method: "GET",
    path: "/api/referrals/{id}/patient-access",
    summary: "Прочитать статус доступа пациента",
    description: "Возвращает только ревизию, активность и срок доступа без capability token.",
    auth: workspace,
    roles: ["owner", "doctor"],
    request: { contentType: "none", fields: [field("id", "referral id", true, "Направление.", "path")], example: null },
    success: { status: 200, description: "Текущий статус ссылки.", example: { accessRevision: 1, active: true, expiresAt: 1793700000000 } },
    errors: [error(401, "UNAUTHORIZED", "Сессия отсутствует."), error(403, "FORBIDDEN", "Роль не разрешена."), error(404, "NOT_FOUND", "Запись скрыта или отсутствует."), error(503, "WORKSPACE_UNAVAILABLE", "Хранилище недоступно.")],
    pathExample: { id: "ref-demo-01" },
  },
  {
    id: "preparation-manage",
    strictQuery: true,
    groupId: "referrals",
    method: "POST",
    path: "/api/referrals/{id}/patient-access",
    summary: "Перевыпустить или отозвать доступ",
    description: "Owner действует только через назначенного активного врача; прежняя ссылка отзывается атомарно.",
    auth: workspace,
    roles: ["owner", "doctor"],
    request: { contentType: "application/json", fields: [field("id", "referral id", true, "Направление.", "path"), field("action", '"reissue" | "revoke"', true, "Операция."), field("expectedAccessRevision", "integer", true, "Версия доступа."), field("idempotencyKey", "string", true, "Ключ повтора.")], example: { action: "reissue", expectedAccessRevision: 1, idempotencyKey: "patient-access-demo-01" } },
    success: { status: 200, description: "Новая URL либо null после отзыва.", example: { preparationUrl: "https://example.test/p/<one-time-token>", expiresAt: 1793700000000 } },
    errors: [...referralErrors, error(409, "ACCESS_CHANGED", "Ссылка уже изменилась."), error(409, "DOCTOR_ASSIGNMENT_REQUIRED", "Нет активного назначенного врача.")],
    pathExample: { id: "ref-demo-01" },
  },
  {
    id: "patient-report-confirm",
    strictQuery: true,
    groupId: "referrals",
    method: "POST",
    path: "/api/referrals/{id}/patient-reports/confirm",
    summary: "Подтвердить отметку пациента",
    description: "Назначенный врач переносит проверенный результат в текущий пакет; исходный self-report остаётся отдельным аудитом.",
    auth: workspace,
    roles: ["doctor"],
    request: { contentType: "application/json", fields: [field("id", "referral id", true, "Направление.", "path"), field("reportId", "string", true, "Версия self-report."), field("expectedRevision", "integer", true, "Версия карточки."), field("expectedReportRevision", "integer", true, "Версия отметки."), field("idempotencyKey", "string", true, "Ключ повтора.")], example: { reportId: "report-demo-01", expectedRevision: 4, expectedReportRevision: 1, idempotencyKey: "confirm-report-demo-01" } },
    success: { status: 200, description: "Карточка с врачебно подтверждённым обследованием.", example: { referral: { id: "ref-demo-01", revision: 5, completeness: { status: "unknown", catalogueValidated: false } } } },
    errors: [...referralErrors, error(409, "APPLICABILITY_UNCONFIRMED", "Условная позиция не подтверждена."), error(409, "REFERRAL_CANCELLED", "Направление отменено.")],
    pathExample: { id: "ref-demo-01" },
  },
  {
    id: "registration-snapshot",
    strictQuery: true,
    groupId: "referrals",
    method: "POST",
    path: "/api/referrals/{id}/registration-snapshot",
    summary: "Зафиксировать входы B3",
    description: "Назначенный врач один раз подтверждает точные значения на момент регистрации; текущие поля карточки не подставляются.",
    auth: workspace,
    roles: ["doctor"],
    request: { contentType: "application/json", fields: [field("id", "referral id", true, "Направление.", "path"), field("expectedRevision", "integer", true, "Версия карточки."), field("idempotencyKey", "string", true, "Ключ повтора."), field("attestedAtRegistration", "true", true, "Явное подтверждение семантики."), field("features", "exact seven-field object", true, "bed_profile и шесть обязательных регистрационных полей.")], example: { expectedRevision: 5, idempotencyKey: "registration-demo-01", attestedAtRegistration: true, features: { bed_profile: null, icd10_ref_diag_code: "synthetic-icd", referring_mo: "synthetic-referring", hospital_mo: "synthetic-hospital", territorial_type: "synthetic-territory", finance_source: "synthetic-finance", referral_purpose: "synthetic-purpose" } } },
    success: { status: 200, description: "Неизменяемый снимок сохранён.", example: { referral: { id: "ref-demo-01", revision: 6, registrationSnapshot: { captured: true } } } },
    errors: [...referralErrors, error(409, "REGISTRATION_SNAPSHOT_IMMUTABLE", "Снимок уже зафиксирован.")],
    pathExample: { id: "ref-demo-01" },
    notes: ["OpenAPI показывает форму входа, но MIS event никогда не содержит эти значения."],
  },
  {
    id: "referral-risk",
    strictQuery: true,
    groupId: "referrals",
    method: "GET",
    path: "/api/referrals/{id}/risk",
    summary: "Рассчитать исследовательский риск B3",
    description: "Read-only расчёт по неизменяемому registration snapshot; unavailable является штатным ответом 200.",
    auth: workspace,
    roles: ["owner", "doctor"],
    request: { contentType: "none", fields: [field("id", "referral id", true, "Направление.", "path")], example: null },
    success: { status: 200, description: "Research-only available/unavailable union.", example: { risk: { status: "unavailable", researchOnly: true, reason: "REGISTRATION_SNAPSHOT_MISSING", missingInputs: ["bed_profile"], inputRevision: null } } },
    errors: [error(400, "BAD_REQUEST", "Query запрещён."), error(401, "UNAUTHORIZED", "Сессия отсутствует."), error(403, "FORBIDDEN", "Роль analyst не допускается."), error(404, "NOT_FOUND", "Запись скрыта или отсутствует."), error(405, "METHOD_NOT_ALLOWED", "Поддерживается только GET."), error(503, "WORKSPACE_UNAVAILABLE", "Хранилище недоступно.")],
    pathExample: { id: "ref-demo-01" },
    notes: ["researchOnly=true; результат не меняет маршрут, срочность или комплектность."],
  },
  {
    id: "openapi",
    groupId: "system",
    method: "GET",
    path: "/api/openapi",
    summary: "Скачать OpenAPI 3.1",
    description: "Детерминированный machine-readable контракт, собранный из того же registry, что и портал.",
    auth: anon,
    request: { contentType: "none", fields: [], example: null },
    success: { status: 200, description: "OpenAPI JSON без runtime secrets.", contentTypes: ["application/vnd.oai.openapi+json;version=3.1"], example: { openapi: "3.1.0", info: { title: "Demeu API", version: "1.0.0" }, paths: {} } },
    errors: [error(500, "INTERNAL", "Контракт не удалось построить.")],
  },
  {
    id: "mis-pull",
    strictQuery: true,
    groupId: "mis",
    method: "POST",
    path: "/api/mis/v1/events/pull",
    summary: "Получить события МИС",
    description: "Атомарно проверяет currentness, выдаёт lease и возвращает только события одной организации.",
    auth: service,
    request: { contentType: "application/json", fields: [field("limit", "integer 1..100", false, "Максимум событий; по умолчанию 20.")], example: { limit: 20 } },
    success: { status: 200, description: "At-least-once события со стабильным eventId.", example: { events: [{ eventId: "event-demo-01", sequence: 3, deliveryId: "delivery-demo-01", deliveryAttempt: 1, type: "referral.readiness.changed", schemaVersion: 1, occurredAt: 1791106225691, subject: { referralId: "ref-demo-01", revision: 8 }, data: { state: "not_ready", reasonCodes: ["SCHEDULE_IN_PAST"], evaluatedOn: "2026-10-04" } }], retryAfterMs: 300000 } },
    errors: [error(400, "BAD_REQUEST", "Body/query неверны."), error(401, "MIS_UNAUTHORIZED", "Service credential не прошла проверку."), error(403, "MIS_FORBIDDEN", "Scope отсутствует."), error(405, "METHOD_NOT_ALLOWED", "Поддерживается только POST."), error(413, "BODY_TOO_LARGE", "Тело превышает предел."), error(429, "RATE_LIMITED", "Локальный процессный лимит превышен."), error(503, "MIS_UNAVAILABLE", "Credential file или snapshot недоступны.")],
    notes: ["Research events дополнительно требуют scope events:research и явную серверную активацию."],
  },
  {
    id: "mis-ack",
    strictQuery: true,
    groupId: "mis",
    method: "POST",
    path: "/api/mis/v1/events/{eventId}/ack",
    summary: "Подтвердить событие МИС",
    description: "Фиксирует durable ACK текущей lease; повтор с тем же ключом и телом возвращает сохранённый результат.",
    auth: service,
    request: { contentType: "application/json", fields: [field("eventId", "event id", true, "Событие.", "path"), field("deliveryId", "delivery id", true, "Текущая lease."), field("idempotencyKey", "string 8..128", true, "Ключ безопасного повтора.")], example: { deliveryId: "delivery-demo-01", idempotencyKey: "ack-demo-0001" } },
    success: { status: 200, description: "Подтверждение сохранено.", example: { eventId: "event-demo-01", acked: true, ackedAt: 1791106229000, replayed: false } },
    errors: [error(400, "BAD_REQUEST", "Body/query неверны."), error(401, "MIS_UNAUTHORIZED", "Service credential не прошла проверку."), error(403, "MIS_FORBIDDEN", "Scope отсутствует."), error(404, "NOT_FOUND", "Событие отсутствует в организации."), error(405, "METHOD_NOT_ALLOWED", "Поддерживается только POST."), error(409, "IDEMPOTENCY_CONFLICT", "Ключ связан с другим телом."), error(409, "DELIVERY_STALE", "Lease истекла или заменена."), error(413, "BODY_TOO_LARGE", "Тело превышает предел."), error(429, "RATE_LIMITED", "Локальный процессный лимит превышен."), error(503, "MIS_UNAVAILABLE", "Credential file или snapshot недоступны.")],
    pathExample: { eventId: "event-demo-01" },
  },
] as const;

export const apiNegativeOperations = [
  { method: "HEAD", path: "/api/analytics/case1", statuses: [401, 405, 503] },
  { method: "HEAD", path: "/api/reference/examination-requirements", statuses: [401, 405, 503] },
  { method: "GET", path: "/api/referrals/{id}/registration-snapshot", statuses: [401, 403, 405, 503] },
  { method: "POST", path: "/api/referrals/{id}/risk", statuses: [401, 403, 405, 503] },
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
  const defaults: Record<string, string> = endpoint.id === "model-detail" ? { id: "triage-lr-v1" }
    : endpoint.id === "intake-detail" ? { id: "a94648da-2d5e-4fe0-9010-72e972733850" }
      : { id: "ref-demo-01", eventId: "event-demo-01" };
  const path = endpoint.path.replace(/\{([^}]+)\}/gu, (_match, name: string) => endpoint.pathExample?.[name] ?? defaults[name] ?? `${name}-demo`);
  return endpoint.id === "referrals-list"
    ? `${path}?state=preparing&profile=${encodeURIComponent("хирургический")}`
    : path;
}

const WORKSPACE_COOKIE_JAR = "./demeu-workspace.cookies";
const PATIENT_COOKIE_JAR = "./demeu-patient.cookies";

function curlAuth(endpoint: ApiEndpoint, baseUrl: string): string[] {
  if (endpoint.id === "auth-state") {
    return [`  --cookie "${WORKSPACE_COOKIE_JAR}" \\\n`];
  }
  if (endpoint.id === "auth-login") {
    return [
      `  --cookie-jar "${WORKSPACE_COOKIE_JAR}" \\\n`,
      `  -H "Origin: ${baseUrl}" \\\n`,
    ];
  }
  if (endpoint.id === "auth-logout") {
    return [
      `  --cookie "${WORKSPACE_COOKIE_JAR}" \\\n`,
      `  --cookie-jar "${WORKSPACE_COOKIE_JAR}" \\\n`,
      `  -H "Origin: ${baseUrl}" \\\n`,
    ];
  }
  if (endpoint.id === "create-link") {
    return [
      `  --cookie "${WORKSPACE_COOKIE_JAR}" \\\n`,
      `  -H "Origin: ${baseUrl}" \\\n`,
    ];
  }
  if (endpoint.id === "chat-start") {
    return [
      `  --cookie-jar "${PATIENT_COOKIE_JAR}" \\\n`,
      `  -H "Origin: ${baseUrl}" \\\n`,
    ];
  }
  if (endpoint.auth.kind === "workspace") {
    return [
      `  --cookie "${WORKSPACE_COOKIE_JAR}" \\\n`,
      ...(endpoint.method === "GET" ? [] : [`  -H "Origin: ${baseUrl}" \\\n`]),
    ];
  }
  if (endpoint.auth.kind === "patient") {
    return [
      `  --cookie "${PATIENT_COOKIE_JAR}" \\\n`,
      `  -H "Origin: ${baseUrl}" \\\n`,
    ];
  }
  if (endpoint.auth.kind === "service") {
    return ['  -H "Authorization: Bearer <credential-id>.<secret>" \\\n'];
  }
  return [];
}

function curlPreamble(endpoint: ApiEndpoint): string {
  if (endpoint.id === "auth-login") {
    return `# Cookie рабочего пространства будет сохранена в ${WORKSPACE_COOKIE_JAR}\n`;
  }
  if (endpoint.id === "create-link") {
    return "# Production: сначала выполните POST /api/workspace/auth.\n" +
      "# Только legacy-режим без workspace: замените --cookie на\n" +
      "#   -H \"x-doctor-code: <doctor-access-code>\"\n";
  }
  if (endpoint.id === "chat-start") {
    return `# Capability-cookie пациента будет сохранена в ${PATIENT_COOKIE_JAR}\n`;
  }
  return "";
}

export function codeExample(endpoint: ApiEndpoint, language: CodeLanguage, baseUrl = "http://localhost:3000"): string {
  const origin = baseUrl.replace(/\/$/u, "");
  const url = `${origin}${endpointUrl(endpoint)}`;
  const body = endpoint.request.example === null ? null : JSON.stringify(endpoint.request.example, null, 2);
  if (language === "curl") {
    const lines = [curlPreamble(endpoint), `curl --request ${endpoint.method} \\\n`, `  --url "${url}" \\\n`, ...curlAuth(endpoint, origin)];
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
    ...(endpoint.auth.kind !== "public" && endpoint.auth.kind !== "service" ? ['  credentials: "include",'] : []),
    ...(endpoint.auth.kind === "service" ? ['  headers: { Authorization: "Bearer <credential-id>.<secret>", "Content-Type": "application/json" },'] : []),
    ...(body !== null ? [...(endpoint.auth.kind === "service" ? [] : ['  headers: { "Content-Type": "application/json" },']), `  body: JSON.stringify(${body.replace(/\n/gu, "\n  ")}),`] : []),
  ];
  return `const response = await fetch("${endpointUrl(endpoint)}", {\n${options.join("\n")}\n});\n\nif (!response.ok) {\n  const problem = await response.json();\n  throw new Error(problem.code ?? "REQUEST_FAILED");\n}\n\nconst data = await response.${endpoint.id === "patient-memo" ? "json() // use blob() with ?format=pdf" : "json()"};`;
}

export function endpointOperation(endpoint: Pick<ApiEndpoint, "method" | "path">): string {
  return `${endpoint.method} ${endpoint.path}`;
}
