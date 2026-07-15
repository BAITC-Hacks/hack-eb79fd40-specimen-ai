# Финальное обучение LR — фактический отчёт

Эти числа получены Python/sklearn и не используются как метрики продукта в README.

## Decontamination
- До очистки: `{'train': 814240, 'validate': 108199, 'test': 109732}`.
- Удалено: `{'train': 0, 'validate': 3429, 'test': 4009}`.
- После очистки: `{'train': 814240, 'validate': 104770, 'test': 105723}`.
- Pairwise overlap после очистки: `{'train_validate': 0, 'train_test': 0, 'validate_test': 0}`.

## Обучение
- Использовано train-строк: **814240** из 814240.
- Стратифицированная подвыборка: **False**; причина: `full_train`; seed: `42`.
- Solver: `saga`, multinomial; elapsed: **163.973 s**; converged: **True**.
- Abstain threshold: **0.503698409**, validation coverage: **1.000000**, accuracy: **0.997032**.
- Held-out test: top1 **0.997323194**, top3 **1.000000000**, N **105723**.

## Provenance
- Dataset: `DDXPlus` v15; `10.6084/m9.figshare.20043374.v15`.
- Source: `https://figshare.com/articles/dataset/DDXPlus_Dataset/20043374`.
- Dataset SHA256: `93933e9a9a7a00d618a931deda7767485af299fe4635bf189a7c63b510e8b172`.
- License: `CC BY 4.0` from `figshare_article_metadata`.
- Standalone LICENSE in release: `False`.
