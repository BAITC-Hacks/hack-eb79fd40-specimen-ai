mode: no-llm

# Demeu evaluation report

Run: `no-llm-e1b367afffae834a`; cases SHA256: `49cefd34395f89126543c1279fe7ba6da22fe33f41c162d3f3126890ddc4a3f9`; model: `lr-v1`.

> top-1/top-3 измерены при ИДЕАЛЬНОМ извлечении (mode=no-llm): LLM-адаптер не участвовал, сквозное качество ниже; extraction_f1 не измерялся
> метрики urgency/routing — против невалидированной врачами таблицы `data/pathology_map.json`

## Measured metrics

| Metric | Value | Numerator/denominator | Status |
|---|---:|---:|---|
| Pathology top-1 | 100.0% | 40/40 | measured; no-llm ideal-extraction upper-bound |
| M11 Abstain rate | 0.0% | 0/40 | measured beside top-1 |
| M12 Coverage-adjusted top-1 | 100.0% | 40/40 | measured beside top-1; no-llm ideal-extraction upper-bound |
| M6 Under-triage rate | 0.0% | 0/40 | UNVALIDATED; метрики urgency/routing — против невалидированной врачами таблицы `data/pathology_map.json` |
| Pathology top-3 | 100.0% | 40/40 | measured; no-llm ideal-extraction upper-bound |
| Routing top-1 strict | 100.0% | 40/40 | UNVALIDATED |
| Routing top-3 strict | 100.0% | 40/40 | UNVALIDATED |
| Routing top-3 differential | 100.0% | 40/40 | UNVALIDATED |
| Urgency accuracy | 97.5% | 39/40 | UNVALIDATED |
| Emergency recall, manual P | 100.0% | 5/5 | measured; FN: none |
| Emergency precision, manual P/N | 100.0% | 5/5 | measured |
| Emergency specificity, manual N | 100.0% | 3/3 | measured |
| M7b emergency recall, table-derived DDX | 100.0% | 7/7 | UNVALIDATED |
| Extraction F1 flat | not_run | —/28 | actual LLM extraction was not run in mode no-llm |
| Extraction F1 dialog | not_run | —/12 | actual LLM extraction was not run in mode no-llm |

## Golden invariants

Overall: **PASS**.
- I1: PASS
- I2: PASS
- I2b: PASS
- I3: PASS
- I4: PASS
- I5: PASS
- I6: PASS
- I7: PASS

## Publication guard

Status: **PARTIAL**. Routing and urgency values must not be described as clinician-validated.
