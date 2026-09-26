# Gates: доступ нейрохирурга и production E2E

Scope: отдельная врачебная учётка test-neuro работает на проде, её вымышленный нейрохирургический опрос доставляет текстовую сводку и читаемый PDF в приватный Telegram-чат оператора.

- [x] G0: гейты сформулированы как проверяемые результаты
  CHECK: node /home/almaz/.codex/skills/unlazy/scripts/gate-lint.mjs GATES-NEURO-DEMO.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=0a976aaa9b1fed6b2a8085264b0f72cfb85e0317645db363f92325986e10f7f9; exit=0; EXPECT=matched; output-sha256=3b75535c6633637708cb7674483c76bb0a3a4660c890e594a1ef250ba7bd8856; output-bytes=1283; shell=/bin/sh; cwd=/home/almaz/dev/demeu/.worktrees/ardan-smoke; path=ec16de762145/22 entries

- [x] G1: отдельная production-учётка роли doctor принадлежит только организации test-neuro и принимает выданный пароль
  EVIDENCE: На production логин neurosurgeon вернул HTTP 200 с role=doctor и organizationId=test-neuro; список этой области пуст, доступ к существующей карточке другой организации вернул неотличимый 404. После попадания первого пароля в пользовательский скриншот пароль немедленно ротирован 26.09: новый вход вернул 200, прежний — 401, sessionVersion увеличен, host-файл и read-only container mount имеют одинаковый SHA-256. Accounts JSON имеет mode 0600 и uid/gid 1001:1001; актуальный пароль хранится только в приватном server-side handoff и передан оператору отдельным Telegram-сообщением.

- [x] G2: Telegram chat id задан для новой врачебной учётки, а production-доставка приняла текст сводки и PDF
  EVIDENCE: neurosurgeon привязан к подтверждённому private-чату оператора. Две завершённые production-сессии получили deliveryStatus=sent и notifiedAt; после каждой в container logs отсутствовали ошибки рендера PDF, sendMessage и sendDocument. Отдельно свежий getUpdates подтвердил входящее сообщение оператора. Вторая врачебная учётка исправлена на подтверждённый private-чат; Telegram принял служебное подтверждение. Имена, usernames и числовые chat id в репозиторий не включены.

- [x] G3: production-путь ссылка → первый ответ → завершённый реалистичный неврологический опрос возвращает контрактно полный результат без HTTP-ошибок
  EVIDENCE: Из neurosurgeon создана и открыта персональная ссылка. Первый пациентский ход вернул 200, закрывая регрессию 14.09. Кейс восходящей симметричной слабости после кишечной инфекции завершился естественно за 2 хода: urgency=urgent, source=model, routing[0]=неврология (0.9974827419), model top-1=Guillain-Barré syndrome (0.9969283317), обязательная оговорка присутствует; deliveryStatus=sent.

- [x] G4: PDF из production-доставки открывается и содержит читаемый русский текст
  EVIDENCE: 26.09 получатель прислал скриншот production private-chat: документ `demeu-summary.pdf` присутствует в доставке и отображается как PDF; получатель подтвердил результат визуально. Сообщение Telegram про restricted chat относится к запрету копирования защищённого сообщения, а не к ошибке файла. Production-рендер и sendDocument завершились без зарегистрированной ошибки, session deliveryStatus=sent.

- [x] G5: после мутаций exact-SHA health, L1 smoke, приватные права файлов и rollback-маркеры проверены
  EVIDENCE: Штатный fail-closed deploy завершён на exact SHA 1a55ad96b3dc4e3b9dcf567375e174ccb6a15c18. Production health сообщает commit=1a55ad9, model=lr-v1, llm_ok=true и processing_mode=external_llm; current image и .deploy_green_sha совпадают с 1a55ad9, .deploy_prev_sha=6431415. L1 smoke против https://84.247.161.211 прошёл: TLS, authenticated workspace, exact health, генерация ссылки, unknown-token 404 и patient page. Accounts/state/.env имеют 0600 и uid/gid 1001:1001; data — 0700 и uid/gid 1001:1001. Разрешённый одноразовый сценарий реально завершился на production: emergency-правила сработали, routing=скорая/приёмный покой, deliveryStatus=sent, ошибок PDF/Telegram/server нет. Первоначальный verifier после успешной доставки ожидал закрытые clinician-only поля в patient API и поэтому завершился FAIL; harness исправлен на проверку результата через authenticated workspace, повторный платный прогон намеренно не выполнялся.
