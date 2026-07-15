# DDXPlus — фактическая инспекция

## Провенанс
- Figshare article: `20043374`, version `15`
- DOI: `10.6084/m9.figshare.20043374.v15`
- Лицензия из metadata первичного источника: `CC BY 4.0` (https://creativecommons.org/licenses/by/4.0/)
- Отдельный LICENSE в опубликованном релизе: **нет**; локальный LICENSE создан из metadata Figshare.

### Файлы
- `LICENSE`: 275 bytes, sha256 `fae196ecb956c720953f22e55315000b1a5c21feb6add4b76c1b28784352101a`
- `PROVENANCE.json`: 2304 bytes, sha256 `2520737fca06459bca55b73c9116f1b538fd715308f70d9324494d7621c231eb`
- `README.md`: 7617 bytes, sha256 `8ffec260c14a6871fe4d5cb8ba7a88f3a2c7759c61be4a329fb79577ffcc7277`
- `release_conditions.json`: 26793 bytes, sha256 `960112db157169215c5a5c1eac0993317d2363c0cf2dadf173735dc503810d48`
- `release_evidences.json`: 198524 bytes, sha256 `980f7020ec068b290b49cca7f2ab0a2058faae37f9a94b113e10b6fe0c882f31`
- `release_test_patients.csv`: 88582473 bytes, sha256 `f7ac3eae934c85780fc9b109a6cac5771540619a02690bee6fc0ab402baec186`
- `release_test_patients.zip`: 18986243 bytes, sha256 `ad3bb981f3453fd7abffb35cc595a1c02197e409c581bff97c1265c33eb00d23`
- `release_train_patients.csv`: 670584506 bytes, sha256 `93933e9a9a7a00d618a931deda7767485af299fe4635bf189a7c63b510e8b172`
- `release_train_patients.zip`: 140923730 bytes, sha256 `174ae1d56f36a15b7144838ecd214e1e1748a5369fc90c559529b6dc6ecfb218`
- `release_validate_patients.csv`: 87371169 bytes, sha256 `b84733533bff01daa1d47d27a0cd4d684bb54a0fc20d80aaee1250ff8ff989ed`
- `release_validate_patients.zip`: 18706053 bytes, sha256 `625a96855becf0efe5da339fd3d440aa99597d48f784957a97dacc3fceaa7e40`

## Evidences
- ФАКТ: число evidences = **223**
- ФАКТ: `data_type` = `{'B': 208, 'C': 10, 'M': 5}`
- ФАКТ: one-hot evidence columns = **972**: B = **208**, C possible-values = **88**, M possible-values = **676**
- ФАКТ: `len(feature_order)` = **975** = 972 evidence columns + age_norm + sex_m + sex_f
- ФАКТ: ключи evidence = `['code_question', 'data_type', 'default_value', 'is_antecedent', 'name', 'possible-values', 'question_en', 'question_fr', 'value_meaning']`

## Патологии (label space)
- ФАКТ: число патологий = **49**
- ФАКТ: ключи pathology = `['antecedents', 'cond-name-eng', 'cond-name-fr', 'condition_name', 'icd10-id', 'severity', 'symptoms']`
- ФАКТ: непустой `icd10-id` = **49/49**
- ФАКТ: severity range = **[1, 5]**
- ФАКТ: pathology at minimum severity: `['Anaphylaxie', 'Laryngospasme', 'Ebola', 'Possible NSTEMI / STEMI', 'OAP/Surcharge pulmonaire']`
- ФАКТ: pathology at maximum severity: `['Attaque de panique', 'IVRS ou virémie', 'Rhinosinusite chronique']`
- ФАКТ: направление шкалы по README релиза: **меньшее значение = более тяжёлое состояние**

## Покрытие демо-сценариев SPINE §8
- `demo1_chest_pain`: **классы-кандидаты существуют; покрытие конкретного сценария НЕ ДОКАЗАНО**; кандидаты: `['Angine instable', 'Angine stable', 'Embolie pulmonaire']`
- `demo2_low_back`: **классы-кандидаты по прямым пробам НЕ НАЙДЕНЫ**; кандидаты: `[]`
- `demo3_common_cold`: **классы-кандидаты существуют; покрытие конкретного сценария НЕ ДОКАЗАНО**; кандидаты: `['Rhinite allergique', 'IVRS ou virémie', 'Possible influenza ou syndrome virémique typique']`

## Строки и классы
- ФАКТ: train = **1025602** строк; классов = **49**; колонки = `['AGE', 'DIFFERENTIAL_DIAGNOSIS', 'SEX', 'PATHOLOGY', 'EVIDENCES', 'INITIAL_EVIDENCE']`
  - top-5: `[('URTI', 64368), ('Viral pharyngitis', 61642), ('Anemia', 50665), ('HIV (initial infection)', 29013), ('Localized edema', 27825)]`
  - bottom-5: `[('Whooping cough', 6070), ('Spontaneous rib fracture', 5712), ('Croup', 2852), ('Ebola', 718), ('Bronchiolitis', 261)]`
- ФАКТ: validate = **132448** строк; классов = **49**; колонки = `['AGE', 'DIFFERENTIAL_DIAGNOSIS', 'SEX', 'PATHOLOGY', 'EVIDENCES', 'INITIAL_EVIDENCE']`
- ФАКТ: test = **134529** строк; классов = **49**; колонки = `['AGE', 'DIFFERENTIAL_DIAGNOSIS', 'SEX', 'PATHOLOGY', 'EVIDENCES', 'INITIAL_EVIDENCE']`

## Raw label space и фактический model class_order
- ФАКТ: raw label space из `release_conditions.json` = **49**
- ФАКТ: после проектного adult-only фильтра `AGE >= 18` model `class_order` = **47**
- ФАКТ: исчезнувшие классы и максимальный возраст в raw train = `{'Bronchiolitis': 1, 'Croup': 9}`
- Следствие: будущий `data/pathology_map.json` должен ключеваться фактическим `class_order` из **47** классов, а не raw-списком из 49.

## Cross-split leakage
Дубли считаются после внутрисплитовой дедупликации и adult-only очистки по проектному ключу `(AGE, SEX, PATHOLOGY, EVIDENCES)`.
- ФАКТ: train↔validate = **3429** полных дублей (**3.17%** от очищенного validate, N=108199)
- ФАКТ: train↔test = **3726** полных дублей (**3.40%** от очищенного test, N=109732)
- Обязательное действие перед финальными train/eval (задачи 3.5/4.x): cross-split decontamination — удалить из validate/test ключи, присутствующие в train, затем переобучить и пересчитать независимую оценку.

## Черновой model artifact
- ФАКТ: `n_train_rows=300000`, `top1=0.9973936499835964`, `top3=1.0`, `n_test=109732`
- Эти `train_metrics` воспроизводимы, но из-за измеренного cross-split leakage могут быть завышены и **не являются независимой оценкой**. В README они не идут; там допустимы только метрики `eval/report.json` по продовому TS-пути после decontamination.
