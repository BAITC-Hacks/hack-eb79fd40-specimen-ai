# Gates: правки Ардана 18.09

Scope: замечания из нового архива реализованы, проверены локально и отделены от внешних блокеров тестового сервера.

- [x] G0: критерии приёмки проверяемы
  CHECK: node /home/almaz/.codex/skills/unlazy/scripts/gate-lint.mjs GATES.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=8e42d38a128c8da71ead431451bafe6b87a0b53014dd5983c425a1f307ba2eee; exit=0; EXPECT=matched; output-sha256=d70f8727c3a294c1938e4a3d470cfbb3f1eec449b594869dc7f42981c2c3528f; output-bytes=625; shell=/bin/sh; cwd=/home/almaz/dev/demeu/.worktrees/ardan-smoke; path=4447367c8070/22 entries

- [x] G1: новый архив сверён с прежним, справочник внесён без ложной врачебной валидации
  EVIDENCE: Сверка zip 18.09 с папкой 17.09: 16 файлов совпадают побайтно, включая 15 PNG; изменены только ответы Ардана, добавлен JSON. В JSON 5 профилей, 86 позиций, validated=false; исходный SHA-256 4970d329106a255e4641d8ee75bf0e81e4a0c21cf51f4c7d5769b2df7a946dc5. В репозитории одна метка приведена к языковому ограничению проекта, что отражено в docs/september-contracts.md.

- [x] G2: просроченное записанное обследование видно по назначенной дате, без даты итог предварительный
  CHECK: npx vitest run tests/unit/referrals.test.ts -t 'истёкший срок записанного|без назначенной даты|считает годность на целевую' >/dev/null && printf 'ARDAN_EXPIRY_OK\n'
  EXPECT: ARDAN_EXPIRY_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=642300dcf522285bd4c2594a3080ea79d3735dd193e55673930ce67e9de3da80; exit=0; EXPECT=matched; output-sha256=52bbce3a13fd5a1a01965e569d5baabd8ee890f61b7c27543c699fdc9a89a4b6; output-bytes=16; shell=/bin/sh; cwd=/home/almaz/dev/demeu/.worktrees/ardan-smoke; path=4447367c8070/22 entries

- [x] G3: код МКБ-10, выбор профиля и версия справочника сохраняются
  CHECK: npx vitest run tests/unit/referrals.test.ts -t 'сохраняет код МКБ-10|использует пять профилей' >/dev/null && printf 'ARDAN_PROFILE_OK\n'
  EXPECT: ARDAN_PROFILE_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=eff8f3a8c2e55cd2820d180387c638c5ab3ab64cf1eab32157a7c622c7d870a7; exit=0; EXPECT=matched; output-sha256=53ff15f7d6642c93edfa14becaaaa90611cb2f079e57cae605c3e3addcf2968e; output-bytes=17; shell=/bin/sh; cwd=/home/almaz/dev/demeu/.worktrees/ardan-smoke; path=4447367c8070/22 entries

- [x] G4: явка до наступления назначенной даты отвергается
  CHECK: npx vitest run tests/unit/referrals.test.ts -t 'отвергает подтверждение явки' >/dev/null && printf 'ARDAN_ATTENDANCE_OK\n'
  EXPECT: ARDAN_ATTENDANCE_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=a693f080025cbfa13286e1a6d06aec3e6c1adbcd99d245ffc3fc081eb1196d9a; exit=0; EXPECT=matched; output-sha256=9ebe487abff9a705429163f59bf7406026c031eae1bba737f582f5221660518a; output-bytes=20; shell=/bin/sh; cwd=/home/almaz/dev/demeu/.worktrees/ardan-smoke; path=4447367c8070/22 entries

- [x] G5: аналитик видит безопасные группы и не получает малые ячейки
  CHECK: npx vitest run tests/unit/referrals.test.ts tests/unit/workspace-insights.test.ts tests/unit/workspace-viewmodel.test.ts -t 'аналитику не раскрывает|не выдаёт среднее|suppression|suppressed groups' >/dev/null && printf 'ARDAN_ANALYTICS_OK\n'
  EXPECT: ARDAN_ANALYTICS_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=b8af91ce9c4704334a62a985cbbef2c76d046d5739eb831954b2674647c88800; exit=0; EXPECT=matched; output-sha256=f2102a5d2c5f4daa3e4c5ecd15958c36667e0ec221adb3c02d06652e2b48bc52; output-bytes=19; shell=/bin/sh; cwd=/home/almaz/dev/demeu/.worktrees/ardan-smoke; path=4447367c8070/22 entries

- [x] G6: рабочий порог подсвечивает активные задержки, игнорируя неизвестное время
  CHECK: npx vitest run tests/unit/operational-delay.test.ts >/dev/null && printf 'ARDAN_DELAY_OK\n'
  EXPECT: ARDAN_DELAY_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=1b5999a852ac47f05f543d587c01f84bd87502c1d0cd6e6e83b0d4f8d15f103b; exit=0; EXPECT=matched; output-sha256=419c9b009bd3f629439e2310596f51c4e66dd6b13b5ab405f639a592162395fc; output-bytes=15; shell=/bin/sh; cwd=/home/almaz/dev/demeu/.worktrees/ardan-smoke; path=4447367c8070/22 entries

- [x] G7: ошибки входа и дат понятны, мобильная комплектность показана
  EVIDENCE: Локальный браузер: неверный пароль показал «Неверный логин или пароль.»; неверный порядок дат показал сообщение у поля «Действует до»; при ширине 390 px метка «Комплектность: Не проверено» имела display:block и находилась внутри viewport.

- [x] G8: первый ход опроса и три демо-сценария проходят с локальным mock API
  CHECK: npm run e2e:mock >/dev/null && printf 'ARDAN_MOCK_E2E_OK\n'
  EXPECT: ARDAN_MOCK_E2E_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=6ad99d941e55d1f50a29db422502d72b41712320cbf0e7f606dd24d083137f62; exit=0; EXPECT=matched; output-sha256=1d641f4a2d518067677d0df2e535acb9488a8267a2b5a57b3694b201383b9c0e; output-bytes=18; shell=/bin/sh; cwd=/home/almaz/dev/demeu/.worktrees/ardan-smoke; path=4447367c8070/22 entries

- [x] G9: вторая учётка врача не получает чужие карточки через API
  CHECK: npx vitest run tests/unit/workspace-api.test.ts -t 'indistinguishable 404' >/dev/null && printf 'ARDAN_DOCTOR_SCOPE_OK\n'
  EXPECT: ARDAN_DOCTOR_SCOPE_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=8be5b76d332f528390480109a6fa1a68b888c5b93293a65c2ffe2fd39807fa03; exit=0; EXPECT=matched; output-sha256=99883f341e80ab1573b08970f6bbc09449df1814cf59248b77baa20dba038449; output-bytes=22; shell=/bin/sh; cwd=/home/almaz/dev/demeu/.worktrees/ardan-smoke; path=4447367c8070/22 entries

- [x] G10: линтер, типы и полный набор тестов проходят
  CHECK: npm run lint >/dev/null && npx tsc --noEmit && npm test -- --maxWorkers=1 >/dev/null && printf 'ARDAN_ALL_CHECKS_OK\n'
  EXPECT: ARDAN_ALL_CHECKS_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=dfea8dcb8af056101a99e54cecea6c1633165a41df0c5acab8076de151c55c4a; exit=0; EXPECT=matched; output-sha256=752087017d2b0672d045a8de466f016d5fc6d32a67e9ee91a8b2f9bf34eb9a09; output-bytes=20; shell=/bin/sh; cwd=/home/almaz/dev/demeu/.worktrees/ardan-smoke; path=4447367c8070/22 entries

- [x] G11: интерфейс направления и мобильная комплектность проверены в браузере
  EVIDENCE: Локальный браузер: создано направление с кодом K80.2 и одним из пяти профилей; карточка показала непроверенную версию перечня, после назначенной даты и записи ОАК показала «Есть истёкшие сроки» и «Срок истёк». Рабочий порог 0 сохранился после reload. Две раздельные HTTP-сессии врачей вернули по одной собственной записи; чужая и несуществующая карточки обе дали 404.

- [ ] G12: живой Anthropic API принимает первый ход опроса
  EVIDENCE: 18.09 локальный live smoke с ключом из /home/almaz/dev/demeu/.env выполнил по одному chat и structured запросу; оба вернули 401 authentication_error: API key is invalid. Mock E2E первого хода прошёл по G8.

- [ ] G13: второй врач создан на тестовом сервере и изоляция проверена там
  EVIDENCE: 18.09 две временные учётки проверены через локальный HTTP API: собственные списки раздельны, чужая и неизвестная карточки дают одинаковый 404. На тестовом сервере учётка не создана и проверка не запускалась.

- [x] G14: памятка врачу передаёт просроченное записанное обследование без чернового списка требований
  CHECK: npx vitest run tests/unit/workspace-api.test.ts -t 'recorded expired examination' >/dev/null && printf 'ARDAN_NOTIFY_EXPIRY_OK\n'
  EXPECT: ARDAN_NOTIFY_EXPIRY_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=73565a1a15e73e12076c1e636a507f9cc774eb50b1283fea2181a7df3310fdba; exit=0; EXPECT=matched; output-sha256=50ddc530ebdbe2ecdfb835d8eab1ad0cecc38c404913ef90b76cf997bcf7edc6; output-bytes=23; shell=/bin/sh; cwd=/home/almaz/dev/demeu/.worktrees/ardan-smoke; path=4447367c8070/22 entries

- [ ] G15: связанная сводка доставлена врачу в Telegram на тестовом сервере
  EVIDENCE: Локальные тесты связывания сводки и mock-доставки прошли в полном наборе. TELEGRAM_BOT_TOKEN в локальном .env отсутствует; на тестовом сервере доставка не проверялась.

ABANDON: G12 Нужен новый действующий ANTHROPIC_API_KEY; текущий ключ отвергнут живым API с 401. После замены ключа повторить live smoke и убрать эту запись.
ABANDON: G13 Учётку врача на тестовом VPS создаёт оператор: агентский SSH запрещён правилами проекта; незакоммиченный worktree нельзя развернуть через deploy.sh, который требует чистый SHA. После операторского деплоя добавить второго врача по docs/workspace-accounts.md и проверить два входа.
ABANDON: G15 Нужны TELEGRAM_BOT_TOKEN и адресат врача на тестовом сервере, а затем операторский прогон доставки; локальный токен отсутствует и агентский SSH запрещён.

- [x] G16: одна команда поднимает локальный кабинет с mock Anthropic и Telegram без внешних ключей
  CHECK: npm run demo:mock -- --check >/dev/null && printf 'DEMEU_DEMO_BOOT_OK\n'
  EXPECT: DEMEU_DEMO_BOOT_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=55407d5bf35828813bc9d95b6792f51a082e855da7b8df2b15122be3da91ee5b; exit=0; EXPECT=matched; output-sha256=6f03b3d59c81a9ba351d49d6d107cf962c8931c7047a2517751e4dfbc592675c; output-bytes=19; shell=/bin/sh; cwd=/home/almaz/dev/demeu/.worktrees/ardan-smoke; path=4447367c8070/22 entries

- [x] G17: в локальном demo работают две учётки врача, аналитик и частично скрытые группы
  EVIDENCE: HTTP smoke вошёл под doctor-a, doctor-b и analyst; каждый врач получил 7 собственных карточек, чужих в списке нет. Браузерный вход doctor-a показал рабочий обзор с 7 карточками; вход analyst показал 6 записей в подготовке и 5 в ожидании, 3 назначенных скрыты вместе с общим итогом и персональными разделами. Выход из кабинета повторно проверен после переноса демо-плашки в поток страницы.

- [x] G18: первый ход пациента, завершение, сводка врачу и PDF проходят через локальные mock API
  EVIDENCE: HTTP smoke с персональной ссылкой вернул 200 на /api/chat/start и первом /api/chat, done=true и emergency; mock Telegram получил sendMessage и sendDocument врачу 100001, PDF скачан и проверен по заголовку %PDF-. Браузерный опрос с той же вымышленной жалобой показал обращение в 103 и завершение; в локальном ящике видны текст сводки и PDF. Дополнительный HTTP smoke завершил три хода с произвольной жалобой у doctor-b и проверил непустое извлечение без перехода в rules_only.

- [x] G19: локальный demo не отправляет запросы за пределы loopback
  CHECK: node scripts/demo-network-guard.test.mjs && printf 'DEMEU_DEMO_NETWORK_OK\n'
  EXPECT: DEMEU_DEMO_NETWORK_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=58388672dced1d689da2235bcea9c0838f9f232fa66237ca2ef91bddbf921ced; exit=0; EXPECT=matched; output-sha256=0690d4958c5f4247667602c8601a49711dba096e489185532f59ad2cf6fa2eb9; output-bytes=52; shell=/bin/sh; cwd=/home/almaz/dev/demeu/.worktrees/ardan-smoke; path=4447367c8070/22 entries

- [x] G20: после demo-режима линтер, типы и полный тестовый набор остаются чистыми
  CHECK: npm run lint >/dev/null && npx tsc --noEmit && npm test -- --maxWorkers=1 >/dev/null && printf 'DEMEU_DEMO_CHECKS_OK\n'
  EXPECT: DEMEU_DEMO_CHECKS_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=61262dab82a4e7e9c192321aac35e6bc5db5ffa8e0456fd95b4edc0cd08039aa; exit=0; EXPECT=matched; output-sha256=eb524a54815477c0dda574570bd41302985932cff90f13fbc040e8c6157a22a8; output-bytes=21; shell=/bin/sh; cwd=/home/almaz/dev/demeu/.worktrees/ardan-smoke; path=4447367c8070/22 entries
