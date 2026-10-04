# Finalization acceptance

## Автоматический интеграционный gate

```bash
npx vitest run tests/integration/finalization-flow.test.ts tests/unit/mock-e2e-workspace-isolation.test.ts tests/unit/referral-detail-scope.test.ts tests/unit/referrals-review.test.ts tests/unit/referrals.test.ts tests/unit/clinical-validation-artifact.test.ts --passWithNoTests=false
```

Smoke создаёт отдельную безопасную копию исходников и приватное временное
хранилище. Он не копирует `.env*`, `.next`, tool state, worktrees, сырые или
производные данные и бинарные веса. Child environment строится по allowlist.
Режим обработки — `deterministic`; Anthropic key, base URL и mock отсутствуют.
Fetch guard разрешает loopback и перенаправляет только точный Telegram mock
route. Любая попытка внешнего fetch делает gate красным.

Процессы запускаются отдельными группами. Cleanup завершает процессы,
дожидается выхода, удаляет временные каталоги и проверяет повторное bind обоих
портов. Только после этих проверок печатается одна строка
`FINALIZATION_SMOKE_RESULT` без паролей, токенов, идентификаторов пациентов,
транскриптов или UUID.

Локальный результат 04.10.2026: exact gate — 6 файлов, 64 теста, всё зелёное;
`npx tsc --noEmit`, scoped ESLint и `git diff --check` завершились с exit 0.
Это writer evidence; итоговые full-suite и production gates выполняются
координатором отдельно.

## Проверяемый путь

- Полные RU и KK questionnaire flows и отдельный KK emergency до следующего
  вопроса.
- Реальные HTTP границы: anonymous, analyst, owner, чужая организация и другой
  врач той же организации.
- Immutable triage и отдельное аудируемое заключение врача до формирования
  списка обследований.
- Два self-report пациента, подтверждение врача, повторный обмен ссылки на
  другом устройстве и RU/KK PDF.
- Честное `catalogueValidated:false`: подтверждённая готовность не появляется.
- B3 registration snapshot и исследовательский score без требования конкретной
  risk band для вымышленных значений.
- MIS research event, monotonic sequence, ACK и идемпотентный replay.
- После перезапуска ACK не доставляется снова, Telegram не дублируется, а
  capability и referral сохраняются.
- После 24-часового retention source intake исчезает, но referral, patient
  package и PDF остаются доступны по исходному patient URL.
- Analyst aggregate не содержит малых групп; live OpenAPI совпадает с
  `docs/openapi.json`.

## Отдельное подтверждение интерфейса

Browser evidence покрывает desktop/mobile RU/KK, meaningful loading, error,
retry и empty states, а также owner/analyst/doctor RBAC. React Strict Mode может
делать два начальных fetch; error probe удерживает все начальные запросы, затем
проверяет `503 → Retry → 200`, иначе успешный duplicate скроет ошибку.

RU и KK PDF в автоматическом gate проверяются как разные валидные документы с
непустыми страницами. Текстовая локализация отдельно подтверждается browser/PDF
evidence; среда Vitest не требует системный `pdftotext`.

Скриншоты не должны включать локальный banner с вымышленными реквизитами,
значения login form или credential files.

Проверка 04.10.2026 на свежем локальном preview подтвердила: кабинет врача с
семью карточками, новый patient capability, RU/KK mobile 390 px без
горизонтального переполнения, две самоотметки пациента, одну отдельную отметку
врача и её видимость пациенту. Оба PDF открылись; локальная текстовая проверка
подтвердила русскую и казахскую локализацию. Evidence сохранён только локально в
private browser artifacts; credential banner и значения входа в кадр не попали.

## Внешние acceptance gates

- Реальная клиническая проверка справочников и пакета остаётся pending; в коде
  и отчётах `validated:false`.
- Реальные MIS credentials и live consumer отсутствуют. Local mock доказывает
  wire/auth/order/idempotence, но не готовность внешней системы.
- Production exact SHA, health и rollback проверяются штатным deploy gate после
  отдельной команды на серверную работу.
- Clinical feedback packet остаётся `pending_clinician_feedback`; синтетический
  benchmark не заменяет отзыв врача.
