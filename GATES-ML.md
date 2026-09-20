# Gates: handoff данных Ардана и исследовательский D1 baseline

Scope: проверить переданный parquet, воспроизводимо обучить исследовательский baseline срока до госпитализации и не выдать его за готовую продуктовую модель. DDXPlus triage-контур и runtime API не меняются; B3 остаётся заблокированным из-за отсутствия причины отказа и снимка пакета.

- [x] G0: определения гейтов проверяемы
  CHECK: node /home/almaz/.codex/skills/unlazy/scripts/gate-lint.mjs GATES-ML.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=f7f28f415408a918049b3fafb4a972dab4f9c85798de2077b6a97de03ebe4f4f; exit=0; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8; shell=/bin/sh; cwd=/home/almaz/dev/demeu/.worktrees/ardan-smoke; path=4447367c8070/22 entries

- [x] G1: входной parquet идентифицирован по хэшу, схеме и агрегатам без публикации строк пациентов
  CHECK: .venv/bin/python -m scripts.referral_ml.audit --input '/home/almaz/Downloads/Telegram Desktop/demeu-data-handoff-2026-09-19/referrals_features.parquet' --output reports/referral-data-audit.json
  EXPECT: REFERRAL_DATA_AUDIT_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=331b00c6642cb3e62dfef7ab2456cdc78eab14cf9d6dc86f97a50e17b19a195c; exit=0; EXPECT=matched; output-sha256=dce30565fa7b27deb94aa254a9d3446eb5f4cee3f4fdd066b781bf4dc6cf946a; output-bytes=23; shell=/bin/sh; cwd=/home/almaz/dev/demeu/.worktrees/ardan-smoke; path=4447367c8070/22 entries

- [x] G2: признаки после события и неоднозначно присоединённые поля физически исключены из D1 pipeline
  CHECK: .venv/bin/python -m unittest discover -s tests/referral_ml -p 'test_*.py' >/dev/null && printf 'REFERRAL_ML_UNIT_OK\n'
  EXPECT: REFERRAL_ML_UNIT_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=704fab1ac207b1550abd3da0632a0f1269341167a53244fa312f518784093977; exit=0; EXPECT=matched; output-sha256=a416cbc093717505511f25cea362e5fa8ca9c61006ae463ecc2db65e0aaabfad; output-bytes=139; shell=/bin/sh; cwd=/home/almaz/dev/demeu/.worktrees/ardan-smoke; path=4447367c8070/22 entries

- [x] G3: train, validation и test разделены по времени, параметры модели выбираются только на validation
  CHECK: .venv/bin/python -m unittest tests.referral_ml.test_wait_pipeline.TemporalSplitTests >/dev/null && printf 'WAIT_SPLIT_OK\n'
  EXPECT: WAIT_SPLIT_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=02db0760cea9d649ee5b260a808907e976951affa30dc72bd42315f9c32621f7; exit=0; EXPECT=matched; output-sha256=65168035873e5bb3caaca01c0990c4fa7788c155af4ef7927392257fcbf5f19e; output-bytes=115; shell=/bin/sh; cwd=/home/almaz/dev/demeu/.worktrees/ardan-smoke; path=4447367c8070/22 entries

- [x] G4: baseline обучается на полном переданном parquet и создаёт проверяемый отчёт
  CHECK: .venv/bin/python -m scripts.referral_ml.train_wait --input '/home/almaz/Downloads/Telegram Desktop/demeu-data-handoff-2026-09-19/referrals_features.parquet' --report reports/wait-time-baseline-v0.json --model-output data/processed/wait-time-baseline-v0.joblib
  EXPECT: WAIT_TIME_BASELINE_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=4ecd86b1d22db61803df13cf34177edf3a973396c3850fe88068b432a2d9720c; exit=0; EXPECT=matched; output-sha256=235fd2af26a7911ea2a605521bd92cdbcaff5fd2cebf3fa9c1761a7e6af3cd67; output-bytes=22; shell=/bin/sh; cwd=/home/almaz/dev/demeu/.worktrees/ardan-smoke; path=4447367c8070/22 entries

- [x] G5: отчёт содержит provenance, неизменённый test, baseline-сравнение, ограничения и статус experimental_not_runtime_ready
  CHECK: .venv/bin/python -m scripts.referral_ml.verify_report reports/wait-time-baseline-v0.json --model data/processed/wait-time-baseline-v0.joblib
  EXPECT: REFERRAL_REPORT_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=26c9e56f6dbf8fb8f681e0b0bf605067b48f496133c37d986911bc73c41c3c47; exit=0; EXPECT=matched; output-sha256=6ca9d27ffe8c26275803c81e1d8b8cc5c3d77aa3d96f77727d5fbfed57a66020; output-bytes=19; shell=/bin/sh; cwd=/home/almaz/dev/demeu/.worktrees/ardan-smoke; path=4447367c8070/22 entries

- [x] G6: повторный запуск воспроизводит семантический отчёт, а каждый joblib проверяется по своему SHA-256
  CHECK: .venv/bin/python -m scripts.referral_ml.train_wait --input '/home/almaz/Downloads/Telegram Desktop/demeu-data-handoff-2026-09-19/referrals_features.parquet' --report /tmp/wait-time-baseline-v0.json --model-output /tmp/wait-time-baseline-v0.joblib --quiet && .venv/bin/python -m scripts.referral_ml.verify_report /tmp/wait-time-baseline-v0.json --model /tmp/wait-time-baseline-v0.joblib >/dev/null && .venv/bin/python -m scripts.referral_ml.compare_reports reports/wait-time-baseline-v0.json /tmp/wait-time-baseline-v0.json
  EXPECT: REFERRAL_REPRODUCIBLE_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=dc66852f45729539f038707d03ac2fb43d0e427a42c9fe4b5f1ef3fd860183ea; exit=0; EXPECT=matched; output-sha256=ed912b96363a1ff9a6b9b1049c29915a9568257c11fd33d3acba96792255b525; output-bytes=25; shell=/bin/sh; cwd=/home/almaz/dev/demeu/.worktrees/ardan-smoke; path=4447367c8070/22 entries

- [x] G7: raw, parquet, ZIP и бинарная модель не попали в git
  CHECK: test -z "$(git ls-files 'data/raw/**' 'data/processed/**' '*.csv' '*.parquet' '*.zip' '*.joblib' '*.pkl' '*.bin')" && printf 'REFERRAL_GIT_HYGIENE_OK\n'
  EXPECT: REFERRAL_GIT_HYGIENE_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=71cf1353a086749d3aec8ef69167333fd7b3a565b98147792820c22df8e3a393; exit=0; EXPECT=matched; output-sha256=4ae672282166d744b8f9bf516ff6b2554538efd873b6e77ae6adedf90305e7b0; output-bytes=24; shell=/bin/sh; cwd=/home/almaz/dev/demeu/.worktrees/ardan-smoke; path=4447367c8070/22 entries

- [x] G8: Python pipeline проходит lint, типы и unit-тесты
  CHECK: .venv/bin/ruff check scripts/referral_ml tests/referral_ml && .venv/bin/mypy scripts/referral_ml && .venv/bin/python -m unittest discover -s tests/referral_ml -p 'test_*.py' >/dev/null && printf 'REFERRAL_PYTHON_CHECKS_OK\n'
  EXPECT: REFERRAL_PYTHON_CHECKS_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=baf06d07ad0c7138f20dca6dd2bfe517169d4bdc9810dea5170b6a7412ef9613; exit=0; EXPECT=matched; output-sha256=6935e65dc3a8f7e62dda5516b4e92a03aa42ed1400f704114aca5863adfb316c; output-bytes=207; shell=/bin/sh; cwd=/home/almaz/dev/demeu/.worktrees/ardan-smoke; path=4447367c8070/22 entries

- [x] G9: обязательные проверки приложения остаются зелёными
  CHECK: npm run lint >/dev/null && npx tsc --noEmit && npm test -- --maxWorkers=1 >/dev/null && printf 'REFERRAL_APP_CHECKS_OK\n'
  EXPECT: REFERRAL_APP_CHECKS_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=6014170261a6dce63a892fd99a424a7f538b7b81236aa32925906202e161cf46; exit=0; EXPECT=matched; output-sha256=f50466c14d663027d32f750d2e71e3c0bba72325f6c2572bd8d573fc46e71116; output-bytes=23; shell=/bin/sh; cwd=/home/almaz/dev/demeu/.worktrees/ardan-smoke; path=4447367c8070/22 entries
