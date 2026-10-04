import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

interface MetricStatus {
  numerator?: number;
  denominator?: number;
  state: string;
}

interface Report {
  mode: string;
  pathology_map_validated: boolean;
  metrics: Record<string, number | null>;
  metric_status: Record<string, MetricStatus>;
}

const readme = readFileSync("docs/technical.md", "utf8");
const productReadme = readFileSync("README.md", "utf8");
const report = JSON.parse(readFileSync("eval/report.json", "utf8")) as Report;

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

function plain(value: string): string {
  return value.replace(/[*_`]/gu, "").replace(/\s+/gu, " ").trim();
}

function tableRows(markdown: string): Map<string, { value: string; status: string }> {
  const parsed = new Map<string, { value: string; status: string }>();
  for (const line of markdown.split(/\r?\n/u)) {
    if (!line.trimStart().startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map(plain);
    if (cells.length !== 3) continue;
    parsed.set(cells[0], { value: cells[1], status: cells[2] });
  }
  return parsed;
}

function assertPublication(markdown: string): void {
  const published = tableRows(markdown);
  const normalized = markdown.replace(/\s+/gu, " ");
  for (const [metric, label] of Object.entries(rows)) {
    const row = published.get(label);
    if (!row) throw new Error(`missing published metric ${label}`);
    const value = report.metrics[metric];
    const status = report.metric_status[metric];
    if (value === null || status.numerator === undefined || status.denominator === undefined) {
      throw new Error(`report metric ${metric} is not publishable`);
    }
    const expectedValue = `${status.numerator}/${status.denominator} (${Number(
      (value * 100).toFixed(1),
    )}%)`;
    if (plain(row.value) !== expectedValue) {
      throw new Error(`${metric} differs from eval/report.json`);
    }
    if (!row.status.toLocaleLowerCase("en").includes(status.state.toLocaleLowerCase("en"))) {
      throw new Error(`${metric} status differs from eval/report.json`);
    }
  }

  if (report.mode !== "no-llm") throw new Error("unexpected eval mode");
  if (report.pathology_map_validated) throw new Error("unexpected validated map");
  if (!/на\s+невалидированной\s+врачами\s+таблице/iu.test(normalized)) {
    throw new Error("missing unvalidated-map caveat");
  }
  if (!/no-llm/iu.test(normalized) || !/идеализированн\p{L}*\s+структурированн\p{L}*/iu.test(normalized)) {
    throw new Error("missing no-LLM ideal-extraction caveat");
  }
  if (!/не\s+доказывает\s+качество[^.]*end-to-end/iu.test(normalized)) {
    throw new Error("missing end-to-end limitation");
  }
  if (/train_metrics|training_report\.json|0\.9973231936286333/iu.test(markdown)) {
    throw new Error("training score leaked into public claims");
  }
}

describe("README publication adversarial checks", () => {
  it("keeps canonical metric evidence discoverable from product README", () => {
    expect(productReadme).toContain("[docs/technical.md](docs/technical.md)");
  });
  it("binds every public value and status to eval/report.json", () => {
    expect(() => assertPublication(readme)).not.toThrow();
  });

  it.each([
    ["deleted metric", (text: string) => text.replace(/^\| Pathology Top-1 .*\n/mu, "")],
    ["denominator substitution", (text: string) => text.replace("40/40 (100%)", "40/50 (100%)")],
    ["percent substitution", (text: string) => text.replace("40/40 (100%)", "40/40 (90%)")],
    ["substituted metric", (text: string) => text.replace("40/40 (100%)", "39/40 (97.5%)")],
    [
      "validated status substitution",
      (text: string) =>
        text.replace(
          "| Routing Top-3 differential | **40/40 (100%)** | UNVALIDATED |",
          "| Routing Top-3 differential | **40/40 (100%)** | measured |",
        ),
    ],
    [
      "removed map caveat",
      (text: string) => text.replaceAll("на невалидированной врачами таблице", "на таблице"),
    ],
    [
      "removed ideal extraction caveat",
      (text: string) =>
        text.replace(/идеализированн\p{L}*\s+структурированн\p{L}*/giu, "структурированным"),
    ],
    [
      "removed end-to-end caveat",
      (text: string) => text.replace(/не доказывает качество[^.]*end-to-end/giu, "не измеряет полный путь"),
    ],
    ["training score injection", (text: string) => `${text}\ntrain_metrics top1=0.9973231936286333\n`],
  ])("rejects %s", (_name, mutate) => {
    expect(() => assertPublication(mutate(readme))).toThrow();
  });
});
