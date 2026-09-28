import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

interface ReportMetricStatus {
  numerator?: number;
  denominator?: number;
  state: string;
}

interface EvalReportSummary {
  mode: string;
  n: { total: number; flat: number; dialog: number; redflag: number };
  metrics: Record<string, number | null>;
  metric_status: Record<string, ReportMetricStatus>;
  pathology_map_validated: boolean;
  invariants: { all_passed: boolean };
}

const readme = readFileSync("README.md", "utf8");
const report = JSON.parse(readFileSync("eval/report.json", "utf8")) as EvalReportSummary;
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts: Record<string, string>;
};

function publishedValue(name: string): string {
  const value = report.metrics[name];
  const status = report.metric_status[name];
  if (value === null || status.numerator === undefined || status.denominator === undefined) {
    throw new Error(`${name} is not publishable`);
  }
  const percent = Number((value * 100).toFixed(1));
  return `${status.numerator}/${status.denominator} (${percent}%)`;
}

describe("README publication contract", () => {
  it("has explicit sections for every data-methodology criterion", () => {
    const headings = [
      "### 1. Источник и происхождение",
      "### 2. Лицензия и атрибуция",
      "### 3. Структура и объём",
      "### 4. Очистка и разделение выборок",
      "### 5. Признаки и целевая переменная",
      "### 6. Почему multinomial logistic regression",
      "### 7. Методика оценки",
      "### 8. Ограничения данных и оценки",
    ];
    for (const heading of headings) expect(readme).toContain(heading);

    expect(readme).toContain("20043374");
    expect(readme).toContain("10.6084/m9.figshare.20043374.v15");
    expect(readme).toContain("CC BY 4.0");
    expect(readme).toContain("1 025 602 / 132 448 / 134 529");
    expect(readme).toContain("814 240 / 104 770 / 105 723");
    expect(readme).toContain("975 признаков");
    expect(readme).toContain("47");
  });

  it("publishes only exact production-eval values with visible caveats", () => {
    const rows: Record<string, string> = {
      pathology_top1: "Pathology Top-1",
      pathology_top3: "Pathology Top-3",
      abstain_rate: "M11 abstain",
      coverage_adjusted_top1: "M12 coverage-adjusted Top-1",
      undertriage_rate: "M6 under-triage",
      routing_top3_differential: "Routing Top-3 differential",
      urgency_accuracy: "Urgency accuracy",
      emergency_recall_manual: "Manual emergency recall",
      emergency_specificity_manual: "Manual emergency specificity",
      emergency_recall_table_ddx: "M7b table-derived emergency recall",
    };
    for (const [metric, label] of Object.entries(rows)) {
      expect(readme).toContain(`| ${label} | **${publishedValue(metric)}**`);
    }

    expect(report.mode).toBe("no-llm");
    expect(report.pathology_map_validated).toBe(false);
    expect(report.invariants.all_passed).toBe(true);
    expect(readme).toContain("M9/M10 extraction F1 | **null/not_run**");
    expect(readme).toContain("Golden invariants I1–I7 | **PASS**");
    expect(readme).toContain("на невалидированной врачами таблице");
    expect(readme).toContain("идеализированным структурированным");
    expect(readme).toContain("не доказывает качество");
    expect(readme).toContain("48 карточек");
    expect(readme).toContain(
      `${report.n.flat} \`flat\`, ${report.n.dialog} \`dialog\` и ${report.n.redflag} ручных`,
    );
  });

  it("never leaks Python training scores into public claims", () => {
    expect(readme).not.toMatch(/train_metrics|training_report\.json/iu);
    expect(readme).not.toContain("0.9973231936286333");
    expect(readme).not.toContain("99.73231936286333");
    expect(readme).toContain("показатели Python-обучения здесь\nне публикуются");
  });

  it("uses the restricted term only in an explicit negative construction", () => {
    const matches = [...readme.matchAll(/диагноз/giu)];
    expect(matches.length).toBeGreaterThan(0);
    for (const match of matches) {
      const before = readme.slice(Math.max(0, match.index! - 24), match.index!);
      expect(before).toMatch(/не\s+(?:ставит\s+)?$/iu);
    }
  });

  it("documents executable commands and every configured environment name", () => {
    for (const script of ["dev", "lint", "test", "build", "eval"] as const) {
      expect(packageJson.scripts[script]).toBeTruthy();
      expect(readme).toContain(script === "test" ? "npm test" : `npm run ${script}`);
    }
    const envNames = readFileSync(".env.example", "utf8")
      .split(/\r?\n/u)
      .map((line) => /^\s*(?:#\s*)?([A-Z][A-Z0-9_]*)\s*=/u.exec(line)?.[1])
      .filter((name): name is string => name !== undefined);
    for (const name of envNames) expect(readme).toContain(`\`${name}\``);

    expect(readme).toContain("docker compose up --build -d");
    expect(readme).toContain("http://localhost:3100/api/healthz");
    expect(readme).toContain("specimen-ai.govtech-kz.com");
    expect(readme).toContain("доверенный TLS");
    expect(readme).toContain("L1");
  });

  it("contains no legacy integration, cut architecture, forbidden stack or secret", () => {
    expect(readme).not.toMatch(/\b(?:Hermes|Kafka|ClickHouse|gRPC|Vue|Postgres|RAG)\b/u);
    expect(readme).not.toMatch(/\bGo\b/u);
    expect(readme).not.toMatch(/sk-ant-[a-z0-9_-]+|bot[0-9]{8,}:/iu);
    expect(readme).not.toContain("ещё не реализован");
  });
});
