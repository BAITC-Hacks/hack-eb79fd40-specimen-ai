import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCES = ["is_bg", "ersb", "eip"] as const;
type Source = typeof SOURCES[number];
const FIELDS = ["referral_id", "registered_at", "admitted_at", "status", "status_at", "organization", "organization_level", "region", "profile", "care_setting", "package_snapshot", "package_snapshot_at", "rejection_reason", "scheduled_at", "attendance_status", "feature_snapshot_at", "reschedule_history", "period", "test_type", "test_count"] as const;
type Field = typeof FIELDS[number];
interface InputSource { source: Source; file: string; columns: Partial<Record<Field, string>> }
interface Config { sources: InputSource[] }
const MAX_BYTES = 10 * 1024 * 1024;

class AuditError extends Error {}
function fail(code: string): never { throw new AuditError(code); }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseAuditConfig(value: unknown): Config {
  if (!object(value) || Object.keys(value).some((key) => key !== "sources") || !Array.isArray(value.sources)) fail("invalid_config");
  const seen = new Set<string>();
  const sources = value.sources.map((entry): InputSource => {
    if (!object(entry) || Object.keys(entry).some((key) => !["source", "file", "columns"].includes(key)) ||
      !SOURCES.includes(entry.source as Source) || seen.has(String(entry.source)) ||
      typeof entry.file !== "string" || !entry.file.trim() || !object(entry.columns)) fail("invalid_config");
    seen.add(String(entry.source));
    const columns: Partial<Record<Field, string>> = {};
    const headers = new Set<string>();
    for (const [field, header] of Object.entries(entry.columns)) {
      if (!FIELDS.includes(field as Field) || typeof header !== "string" || !header.trim() || headers.has(header)) fail("invalid_config");
      headers.add(header);
      columns[field as Field] = header;
    }
    return { source: entry.source as Source, file: entry.file, columns };
  });
  return { sources };
}

async function boundedRead(filename: string, limit: number): Promise<Buffer> {
  const handle = await open(filename, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) fail("not_regular_file");
    if (stat.size > limit) fail("input_too_large");
    const buffer = Buffer.alloc(limit + 1);
    let count = 0;
    while (count <= limit) {
      const { bytesRead } = await handle.read(buffer, count, limit + 1 - count, null);
      if (bytesRead === 0) break;
      count += bytesRead;
    }
    if (count > limit) fail("input_too_large");
    return buffer.subarray(0, count);
  } finally { await handle.close(); }
}

// Comma CSV only: strict quotes, escaped quotes, CRLF/LF and quoted newlines.
// Yield rows so the audit never retains a second full copy of the dataset.
function* csvRows(text: string): Generator<string[]> {
  let row: string[] = [];
  let cell = "";
  let state: "plain" | "quoted" | "closed" = "plain";
  let pending = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    pending = true;
    if (state === "quoted") {
      if (char === '"') {
        if (text[index + 1] === '"') { cell += '"'; index += 1; }
        else state = "closed";
      } else cell += char;
      continue;
    }
    if (char === ',' || char === '\n' || char === '\r') {
      row.push(cell); cell = ""; state = "plain";
      if (char !== ',') {
        if (char === '\r' && text[++index] !== '\n') fail("invalid_csv");
        yield row; row = []; pending = false;
      }
    } else if (char === '"' && state === "plain" && cell.length === 0) {
      state = "quoted";
    } else {
      if (state === "closed" || char === '"' || char === '\0') fail("invalid_csv");
      cell += char;
    }
  }
  if (state === "quoted") fail("invalid_csv");
  if (pending) { row.push(cell); yield row; }
}

interface SourceReport {
  source: Source;
  status: "blocked" | "needs_semantic_review";
  reason: string;
  sha256?: string;
  byte_count?: number;
  row_count?: number;
  mapped_fields: Field[];
  missing_columns: Field[];
  empty_counts: Partial<Record<Field, number>>;
}

async function inspect(input: InputSource, baseDirectory: string): Promise<SourceReport> {
  const result: SourceReport = { source: input.source, status: "blocked", reason: "missing_data", mapped_fields: [], missing_columns: [], empty_counts: {} };
  try {
    if (path.extname(input.file).toLowerCase() !== ".csv") fail("unsupported_format");
    const bytes = await boundedRead(path.resolve(baseDirectory, input.file), MAX_BYTES);
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { return { ...result, reason: "invalid_utf8" }; }
    const rows = csvRows(text);
    const first = rows.next();
    if (first.done || first.value.some((header) => !header.trim()) || new Set(first.value).size !== first.value.length) fail("invalid_header");
    const header = first.value;
    const positions = new Map<Field, number>();
    for (const [field, name] of Object.entries(input.columns) as [Field, string][]) {
      const index = header.indexOf(name);
      if (index < 0) result.missing_columns.push(field);
      else { positions.set(field, index); result.empty_counts[field] = 0; }
    }
    let rowCount = 0;
    for (const row of rows) {
      if (row.length !== header.length) fail("invalid_row_width");
      rowCount += 1;
      for (const [field, index] of positions) {
        if (!row[index].trim()) result.empty_counts[field]! += 1;
      }
    }
    result.sha256 = createHash("sha256").update(bytes).digest("hex");
    result.byte_count = bytes.length;
    result.row_count = rowCount;
    result.mapped_fields = [...positions.keys()].sort();
    result.missing_columns.sort();
    result.reason = rowCount === 0 ? "empty_data" : result.missing_columns.length > 0 ? "missing_columns" : positions.size === 0 ? "missing_mapping" : "semantics_unverified";
    if (result.reason === "semantics_unverified") result.status = "needs_semantic_review";
    return result;
  } catch (error) {
    // Never expose filesystem paths, column labels, or raw parser exceptions.
    return { source: input.source, status: "blocked", reason: error instanceof AuditError ? error.message : "unreadable_file", mapped_fields: [], missing_columns: [], empty_counts: {} };
  }
}

const REQUIREMENTS: Record<string, { source: Source; fields: Field[]; reviews: string[] }> = {
  D1: { source: "is_bg", fields: ["registered_at", "admitted_at", "status", "status_at", "organization", "organization_level", "profile", "care_setting"], reviews: ["prediction_time_and_horizon", "waiting_and_cancelled_censoring", "temporal_holdout", "organization_coverage", "overload_definition"] },
  D2: { source: "eip", fields: ["period", "region", "test_type", "test_count"], reviews: ["volume_unit_and_granularity", "missing_period_not_zero", "forecast_horizon", "temporal_backtest", "capacity_needed_for_shift_or_reagent_planning"] },
  B3: { source: "is_bg", fields: ["referral_id", "registered_at", "status_at", "rejection_reason", "package_snapshot", "package_snapshot_at", "feature_snapshot_at", "profile", "organization_level"], reviews: ["rejection_target_status_dictionary", "mature_outcomes_and_prediction_time", "package_requirements_reference", "features_before_outcome", "temporal_holdout", "class_balance"] },
  D4: { source: "is_bg", fields: ["referral_id", "scheduled_at", "attendance_status", "status_at", "feature_snapshot_at"], reviews: ["attendance_target_status_dictionary", "mature_outcomes", "cancelled_rescheduled_not_negative", "features_before_outcome", "temporal_holdout", "class_balance"] },
};

export async function auditReferralData(value: unknown = { sources: [] }, baseDirectory = process.cwd()) {
  const config = parseAuditConfig(value);
  const sources: SourceReport[] = [];
  for (const source of SOURCES) {
    const input = config.sources.find((entry) => entry.source === source);
    sources.push(input ? await inspect(input, baseDirectory) : { source, status: "blocked", reason: "missing_data", mapped_fields: [], missing_columns: [], empty_counts: {} });
  }
  const tasks = Object.entries(REQUIREMENTS).map(([task, requirement]) => {
    const source = sources.find((entry) => entry.source === requirement.source)!;
    const missing = requirement.fields.filter((field) => !source.mapped_fields.includes(field));
    const empty = requirement.fields.filter((field) => source.empty_counts[field] === source.row_count && source.row_count !== undefined);
    return { task, source: requirement.source, status: source.status === "blocked" || missing.length || empty.length ? "blocked" : "needs_semantic_review", missing_fields: missing, all_empty_fields: empty, pending_reviews: requirement.reviews };
  });
  return { schema_version: 1, status: tasks.some((task) => task.status === "blocked") ? "blocked" : "needs_semantic_review", scope: "metadata_only_no_model_readiness", sources, tasks };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--config")) fail("usage: npx tsx scripts/audit-referral-data.ts [--config local-config.json]");
  let config: unknown = { sources: [] };
  if (args.length) {
    try { config = JSON.parse((await boundedRead(path.resolve(args[1]), 64 * 1024)).toString("utf8")); }
    catch { fail("invalid_or_unreadable_config"); }
  }
  const report = await auditReferralData(config, args.length ? path.dirname(path.resolve(args[1])) : process.cwd());
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.status === "blocked" ? 2 : 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof AuditError ? error.message : "audit_failed"}\n`);
    process.exitCode = 1;
  });
}
