import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  isWorkspaceAuthError,
  requireWorkspaceActor,
  WorkspaceAuthError,
  type WorkspaceActor,
} from "./workspace-auth";

export type Case1Signal = "refusal_above_expected" | "long_wait_above_expected";

export interface Case1ExternalMetrics {
  referrals: number;
  refusal_pct: number;
  hospitalized: number;
  wait_median_days: number | null;
  wait_p90_days: number | null;
  wait_over_30_pct: number | null;
}

export interface Case1Metrics extends Case1ExternalMetrics {
  self_referral_pct: number;
  external_24h: Case1ExternalMetrics | null;
}

export interface Case1Region extends Omit<Case1Metrics, "external_24h"> {
  external_24h: Case1ExternalMetrics;
  code: string;
  name: string;
  treated_in_other_region_pct: number;
  hospitals: number;
  monthly_referrals: Record<string, number>;
}

export interface Case1Hospital extends Case1Metrics {
  name: string;
  region_code: string;
  region: string;
  from_other_regions_pct: number;
  day_stay_pct: number;
  top_profiles: { profile: string; referrals: number }[];
  refusal_vs_expected: {
    observed: number;
    expected: number;
    ratio: number | null;
    ci95: [number, number] | null;
    excess: number;
  };
  long_wait_vs_expected?: {
    observed: number;
    expected: number;
    ratio: number | null;
    ci95: [number, number] | null;
  } | null;
  march_forecast: {
    forecast: number;
    naive: number;
    actual: number;
    pending_at_cutoff: number;
    from_pending: number;
    from_new: number;
  };
  signals: Case1Signal[];
}

export interface Case1Analytics {
  schema_version: 1;
  status: "offline_snapshot";
  generated_at: string;
  source: {
    name: string;
    publisher: string;
    dataset: string;
    registration_period: [string, string];
    outcomes_observed_until: string;
    inputs: { file: string; bytes: number; sha256: string }[];
  };
  definitions: {
    region: string;
    hospital_region: string;
    refusal: string;
    wait_days: string;
    self_referral: string;
    external_24h: string;
    day_stay: string;
    refusal_vs_expected: string;
    signals: string;
  };
  limitations: string[];
  national: Case1Metrics & {
    external_24h: Case1ExternalMetrics;
    hospitals_total: number;
    treated_in_other_region_pct: number;
  };
  weekly: { week_start: string; referrals: number; refusal_pct: number }[];
  regions: Case1Region[];
  profiles: (Case1Metrics & { profile: string })[];
  factors: { factor: string; value: string; referrals: number; refusal_pct: number; lift: number }[];
  forecast: {
    target: string;
    made_at: string;
    horizon_days: number;
    method: string;
    selection_note: string;
    working_days: { february: number; march: number };
    baseline: string;
    baseline_calendar: string;
    hospitals: number;
    model: Case1ForecastMetrics;
    flow_only: Case1ForecastMetrics;
    naive: Case1ForecastMetrics;
    naive_calendar: Case1ForecastMetrics;
    national: { forecast: number; naive: number; naive_calendar: number; actual: number };
  };
  hospitals: Case1Hospital[];
  signals_summary: {
    hospitals_checked: number;
    refusal_above_expected: number;
    long_wait_above_expected: number;
    both: number;
    top_by_excess_refusals: {
      name: string;
      region: string;
      excess_refusals: number;
      signals: Case1Signal[];
    }[];
  };
}

interface Case1ForecastMetrics {
  mae_admissions: number;
  wape_pct: number;
  median_abs_pct_error: number;
}

export interface Case1AnalyticsDeps {
  actor?: (req: Request) => Promise<WorkspaceActor>;
  load?: () => Promise<unknown>;
}

const ARTIFACT_PATH = resolve(process.cwd(), "data/case1/aggregates.json");
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const;
let cachedArtifact: Case1Analytics | null = null;

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${path}`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, expected: readonly string[], path: string): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) throw new Error(`Invalid ${path} keys`);
}

function array(value: unknown, path: string, allowEmpty = false): unknown[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) throw new Error(`Invalid ${path}`);
  return value;
}

function text(value: unknown, path: string, max = 20_000): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) throw new Error(`Invalid ${path}`);
  return value;
}

function integer(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`Invalid ${path}`);
  return Number(value);
}

function finite(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) throw new Error(`Invalid ${path}`);
  return value;
}

function percent(value: unknown, path: string): number {
  const result = finite(value, path);
  if (result > 100) throw new Error(`Invalid ${path}`);
  return result;
}

function calendarDate(value: unknown, path: string): string {
  const result = text(value, path, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(result) || new Date(`${result}T00:00:00.000Z`).toISOString().slice(0, 10) !== result) throw new Error(`Invalid ${path}`);
  return result;
}

function timestamp(value: unknown, path: string): string {
  const result = text(value, path, 64);
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(result) || !Number.isFinite(Date.parse(result))) throw new Error(`Invalid ${path}`);
  return result;
}

function validateExternal(value: unknown, path: string, sparseWait = false): void {
  const item = record(value, path);
  exact(item, ["referrals", "refusal_pct", "hospitalized", "wait_median_days", "wait_p90_days", "wait_over_30_pct"], path);
  integer(item.referrals, `${path}.referrals`);
  percent(item.refusal_pct, `${path}.refusal_pct`);
  integer(item.hospitalized, `${path}.hospitalized`);
  if (Number(item.hospitalized) > Number(item.referrals)) throw new Error(`Invalid ${path}.hospitalized`);
  for (const key of ["wait_median_days", "wait_p90_days"] as const) {
    if (item[key] === null && sparseWait) continue;
    finite(item[key], `${path}.${key}`, sparseWait ? Number.NEGATIVE_INFINITY : 0);
  }
  if (!(item.wait_over_30_pct === null && sparseWait)) percent(item.wait_over_30_pct, `${path}.wait_over_30_pct`);
}

function validateMetrics(value: Record<string, unknown>, path: string, externalNullable: boolean, sparseWait = false): void {
  for (const key of ["referrals", "hospitalized"] as const) integer(value[key], `${path}.${key}`);
  for (const key of ["refusal_pct", "wait_over_30_pct", "self_referral_pct"] as const) percent(value[key], `${path}.${key}`);
  for (const key of ["wait_median_days", "wait_p90_days"] as const) finite(value[key], `${path}.${key}`, sparseWait ? Number.NEGATIVE_INFINITY : 0);
  if (Number(value.hospitalized) > Number(value.referrals)) throw new Error(`Invalid ${path}.hospitalized`);
  if (value.external_24h === null && externalNullable) return;
  validateExternal(value.external_24h, `${path}.external_24h`, sparseWait);
  if (Number(record(value.external_24h, `${path}.external_24h`).referrals) > Number(value.referrals)) throw new Error(`Invalid ${path}.external_24h.referrals`);
}

function validateSignalList(value: unknown, path: string): Case1Signal[] {
  const result = array(value, path, true);
  const allowed = new Set<Case1Signal>(["refusal_above_expected", "long_wait_above_expected"]);
  if (new Set(result).size !== result.length || result.some((entry) => typeof entry !== "string" || !allowed.has(entry as Case1Signal))) throw new Error(`Invalid ${path}`);
  return result as Case1Signal[];
}

function validateForecastMetrics(value: unknown, path: string): void {
  const item = record(value, path);
  exact(item, ["mae_admissions", "wape_pct", "median_abs_pct_error"], path);
  finite(item.mae_admissions, `${path}.mae_admissions`);
  finite(item.wape_pct, `${path}.wape_pct`);
  finite(item.median_abs_pct_error, `${path}.median_abs_pct_error`);
}

function validateRatio(value: unknown, path: string, includeExcess: boolean): void {
  const item = record(value, path);
  exact(item, includeExcess ? ["observed", "expected", "ratio", "ci95", "excess"] : ["observed", "expected", "ratio", "ci95"], path);
  integer(item.observed, `${path}.observed`);
  finite(item.expected, `${path}.expected`);
  if (item.ratio !== null) finite(item.ratio, `${path}.ratio`);
  if (item.ci95 !== null) {
    const interval = array(item.ci95, `${path}.ci95`);
    if (interval.length !== 2 || finite(interval[0], `${path}.ci95[0]`) > finite(interval[1], `${path}.ci95[1]`)) throw new Error(`Invalid ${path}.ci95`);
  }
  if (includeExcess && (typeof item.excess !== "number" || !Number.isFinite(item.excess))) throw new Error(`Invalid ${path}.excess`);
}

export function validateCase1Analytics(value: unknown): Case1Analytics {
  const root = record(value, "case1 analytics");
  exact(root, ["schema_version", "status", "generated_at", "source", "definitions", "limitations", "national", "weekly", "regions", "profiles", "factors", "forecast", "hospitals", "signals_summary"], "case1 analytics");
  if (root.schema_version !== 1 || root.status !== "offline_snapshot") throw new Error("Unsupported Case 1 schema");
  timestamp(root.generated_at, "generated_at");

  const source = record(root.source, "source");
  exact(source, ["name", "publisher", "dataset", "registration_period", "outcomes_observed_until", "inputs"], "source");
  for (const key of ["name", "publisher", "dataset"] as const) text(source[key], `source.${key}`);
  const period = array(source.registration_period, "source.registration_period");
  if (period.length !== 2 || calendarDate(period[0], "source.registration_period[0]") > calendarDate(period[1], "source.registration_period[1]")) throw new Error("Invalid source.registration_period");
  if (calendarDate(source.outcomes_observed_until, "source.outcomes_observed_until") < calendarDate(period[1], "source.registration_period[1]")) throw new Error("Invalid source observation period");
  const inputNames = new Set<string>();
  for (const [index, raw] of array(source.inputs, "source.inputs").entries()) {
    const input = record(raw, `source.inputs[${index}]`);
    exact(input, ["file", "bytes", "sha256"], `source.inputs[${index}]`);
    const file = text(input.file, `source.inputs[${index}].file`, 500);
    if (inputNames.has(file) || file.includes("/") || file.includes("\\")) throw new Error("Invalid source input file");
    inputNames.add(file);
    if (integer(input.bytes, `source.inputs[${index}].bytes`) === 0 || !/^[a-f0-9]{64}$/u.test(text(input.sha256, `source.inputs[${index}].sha256`, 64))) throw new Error("Invalid source input provenance");
  }

  const definitionKeys = ["region", "hospital_region", "refusal", "wait_days", "self_referral", "external_24h", "day_stay", "refusal_vs_expected", "signals"] as const;
  const definitions = record(root.definitions, "definitions");
  exact(definitions, definitionKeys, "definitions");
  for (const key of definitionKeys) text(definitions[key], `definitions.${key}`);
  const limitations = array(root.limitations, "limitations").map((entry, index) => text(entry, `limitations[${index}]`));
  if (new Set(limitations).size !== limitations.length) throw new Error("Duplicate limitations");

  const baseKeys = ["referrals", "refusal_pct", "hospitalized", "wait_median_days", "wait_p90_days", "wait_over_30_pct", "self_referral_pct", "external_24h"] as const;
  const national = record(root.national, "national");
  exact(national, [...baseKeys, "hospitals_total", "treated_in_other_region_pct"], "national");
  validateMetrics(national, "national", false);
  integer(national.hospitals_total, "national.hospitals_total");
  percent(national.treated_in_other_region_pct, "national.treated_in_other_region_pct");

  let weeklyTotal = 0;
  const weeks = new Set<string>();
  let priorWeek = "";
  for (const [index, raw] of array(root.weekly, "weekly").entries()) {
    const week = record(raw, `weekly[${index}]`);
    exact(week, ["week_start", "referrals", "refusal_pct"], `weekly[${index}]`);
    const date = calendarDate(week.week_start, `weekly[${index}].week_start`);
    if (weeks.has(date)) throw new Error("Duplicate weekly period");
    if (date <= priorWeek) throw new Error("Weekly periods are not sorted");
    weeks.add(date);
    priorWeek = date;
    weeklyTotal += integer(week.referrals, `weekly[${index}].referrals`);
    percent(week.refusal_pct, `weekly[${index}].refusal_pct`);
  }

  let regionTotal = 0;
  const regionCodes = new Set<string>();
  const regionNames = new Set<string>();
  const regionByCode = new Map<string, string>();
  for (const [index, raw] of array(root.regions, "regions").entries()) {
    const region = record(raw, `regions[${index}]`);
    exact(region, [...baseKeys, "code", "name", "treated_in_other_region_pct", "hospitals", "monthly_referrals"], `regions[${index}]`);
    validateMetrics(region, `regions[${index}]`, false);
    const code = text(region.code, `regions[${index}].code`, 32);
    const name = text(region.name, `regions[${index}].name`, 500);
    if (regionCodes.has(code) || regionNames.has(name)) throw new Error("Duplicate region");
    regionCodes.add(code); regionNames.add(name); regionByCode.set(code, name);
    percent(region.treated_in_other_region_pct, `regions[${index}].treated_in_other_region_pct`);
    integer(region.hospitals, `regions[${index}].hospitals`);
    const months = record(region.monthly_referrals, `regions[${index}].monthly_referrals`);
    if (Object.keys(months).length === 0 || Object.keys(months).some((month) => !/^\d{4}-\d{2}$/u.test(month) || calendarDate(`${month}-01`, "monthly period").slice(0, 7) !== month)) throw new Error("Invalid monthly referrals");
    const monthlyTotal = Object.entries(months).reduce((sum, [month, count]) => sum + integer(count, `regions[${index}].monthly_referrals.${month}`), 0);
    if (monthlyTotal !== region.referrals) throw new Error("Region monthly totals disagree");
    regionTotal += integer(region.referrals, `regions[${index}].referrals`);
  }
  if (weeklyTotal !== national.referrals || regionTotal !== national.referrals) throw new Error("National referral totals disagree");

  const profileNames = new Set<string>();
  for (const [index, raw] of array(root.profiles, "profiles").entries()) {
    const profile = record(raw, `profiles[${index}]`);
    exact(profile, [...baseKeys, "profile"], `profiles[${index}]`);
    validateMetrics(profile, `profiles[${index}]`, true);
    const name = text(profile.profile, `profiles[${index}].profile`, 500);
    if (profileNames.has(name)) throw new Error("Duplicate profile");
    profileNames.add(name);
  }

  const factorKeys = new Set<string>();
  for (const [index, raw] of array(root.factors, "factors").entries()) {
    const factor = record(raw, `factors[${index}]`);
    exact(factor, ["factor", "value", "referrals", "refusal_pct", "lift"], `factors[${index}]`);
    const key = `${text(factor.factor, `factors[${index}].factor`)}\0${text(factor.value, `factors[${index}].value`)}`;
    if (factorKeys.has(key)) throw new Error("Duplicate factor");
    factorKeys.add(key);
    integer(factor.referrals, `factors[${index}].referrals`);
    percent(factor.refusal_pct, `factors[${index}].refusal_pct`);
    finite(factor.lift, `factors[${index}].lift`);
  }

  const forecast = record(root.forecast, "forecast");
  exact(forecast, ["target", "made_at", "horizon_days", "method", "selection_note", "working_days", "baseline", "baseline_calendar", "hospitals", "model", "flow_only", "naive", "naive_calendar", "national"], "forecast");
  for (const key of ["target", "method", "selection_note", "baseline", "baseline_calendar"] as const) text(forecast[key], `forecast.${key}`);
  calendarDate(forecast.made_at, "forecast.made_at");
  if (integer(forecast.horizon_days, "forecast.horizon_days") === 0) throw new Error("Invalid forecast horizon");
  const workingDays = record(forecast.working_days, "forecast.working_days");
  exact(workingDays, ["february", "march"], "forecast.working_days");
  integer(workingDays.february, "forecast.working_days.february");
  integer(workingDays.march, "forecast.working_days.march");
  for (const key of ["model", "flow_only", "naive", "naive_calendar"] as const) validateForecastMetrics(forecast[key], `forecast.${key}`);
  const forecastNational = record(forecast.national, "forecast.national");
  exact(forecastNational, ["forecast", "naive", "naive_calendar", "actual"], "forecast.national");
  for (const key of ["forecast", "naive", "naive_calendar", "actual"] as const) integer(forecastNational[key], `forecast.national.${key}`);

  const hospitalKeys = new Set<string>();
  const signalCounts: Record<Case1Signal, number> = { refusal_above_expected: 0, long_wait_above_expected: 0 };
  let bothSignals = 0;
  const hospitalLookup = new Map<string, { excess: number; signals: Case1Signal[] }>();
  const hospitals = array(root.hospitals, "hospitals");
  for (const [index, raw] of hospitals.entries()) {
    const hospital = record(raw, `hospitals[${index}]`);
    const hospitalRequiredKeys = [...baseKeys, "name", "region_code", "region", "from_other_regions_pct", "day_stay_pct", "top_profiles", "refusal_vs_expected", "march_forecast", "signals"];
    exact(hospital, hospital.long_wait_vs_expected === undefined ? hospitalRequiredKeys : [...hospitalRequiredKeys, "long_wait_vs_expected"], `hospitals[${index}]`);
    validateMetrics(hospital, `hospitals[${index}]`, true, true);
    const name = text(hospital.name, `hospitals[${index}].name`, 1_000);
    const regionCode = text(hospital.region_code, `hospitals[${index}].region_code`, 32);
    const regionName = text(hospital.region, `hospitals[${index}].region`, 500);
    if (regionByCode.get(regionCode) !== regionName) throw new Error("Hospital region is unknown");
    const key = `${regionCode}\0${name}`;
    if (hospitalKeys.has(key)) throw new Error("Duplicate hospital");
    hospitalKeys.add(key);
    percent(hospital.from_other_regions_pct, `hospitals[${index}].from_other_regions_pct`);
    percent(hospital.day_stay_pct, `hospitals[${index}].day_stay_pct`);
    const topProfileNames = new Set<string>();
    let topProfileTotal = 0;
    for (const [profileIndex, rawProfile] of array(hospital.top_profiles, `hospitals[${index}].top_profiles`, true).entries()) {
      const topProfile = record(rawProfile, `hospitals[${index}].top_profiles[${profileIndex}]`);
      exact(topProfile, ["profile", "referrals"], `hospitals[${index}].top_profiles[${profileIndex}]`);
      const profileName = text(topProfile.profile, `hospitals[${index}].top_profiles[${profileIndex}].profile`, 500);
      if (topProfileNames.has(profileName)) throw new Error("Duplicate hospital top profile");
      topProfileNames.add(profileName);
      topProfileTotal += integer(topProfile.referrals, `hospitals[${index}].top_profiles[${profileIndex}].referrals`);
    }
    if (topProfileTotal > Number(hospital.referrals)) throw new Error("Hospital top profiles disagree");
    validateRatio(hospital.refusal_vs_expected, `hospitals[${index}].refusal_vs_expected`, true);
    if (hospital.long_wait_vs_expected !== undefined && hospital.long_wait_vs_expected !== null) validateRatio(hospital.long_wait_vs_expected, `hospitals[${index}].long_wait_vs_expected`, false);
    const march = record(hospital.march_forecast, `hospitals[${index}].march_forecast`);
    exact(march, ["forecast", "naive", "actual", "pending_at_cutoff", "from_pending", "from_new"], `hospitals[${index}].march_forecast`);
    for (const marchKey of ["forecast", "naive", "actual", "pending_at_cutoff", "from_pending", "from_new"] as const) integer(march[marchKey], `hospitals[${index}].march_forecast.${marchKey}`);
    const signals = validateSignalList(hospital.signals, `hospitals[${index}].signals`);
    for (const signal of signals) signalCounts[signal] += 1;
    if (signals.length === 2) bothSignals += 1;
    hospitalLookup.set(`${regionName}\0${name}`, { excess: record(hospital.refusal_vs_expected, "refusal ratio").excess as number, signals });
  }
  if (integer(forecast.hospitals, "forecast.hospitals") !== hospitals.length) throw new Error("Forecast hospital count disagrees");

  const summary = record(root.signals_summary, "signals_summary");
  exact(summary, ["hospitals_checked", "refusal_above_expected", "long_wait_above_expected", "both", "top_by_excess_refusals"], "signals_summary");
  if (integer(summary.hospitals_checked, "signals_summary.hospitals_checked") !== hospitals.length
    || integer(summary.refusal_above_expected, "signals_summary.refusal_above_expected") !== signalCounts.refusal_above_expected
    || integer(summary.long_wait_above_expected, "signals_summary.long_wait_above_expected") !== signalCounts.long_wait_above_expected
    || integer(summary.both, "signals_summary.both") !== bothSignals) throw new Error("Signal summary disagrees");
  let priorExcess = Number.POSITIVE_INFINITY;
  const rankedHospitals = new Set<string>();
  for (const [index, raw] of array(summary.top_by_excess_refusals, "signals_summary.top_by_excess_refusals", true).entries()) {
    const item = record(raw, `signals_summary.top_by_excess_refusals[${index}]`);
    exact(item, ["name", "region", "excess_refusals", "signals"], `signals_summary.top_by_excess_refusals[${index}]`);
    const name = text(item.name, `signals_summary.top_by_excess_refusals[${index}].name`, 1_000);
    const region = text(item.region, `signals_summary.top_by_excess_refusals[${index}].region`, 500);
    const excess = finite(item.excess_refusals, `signals_summary.top_by_excess_refusals[${index}].excess_refusals`);
    const signals = validateSignalList(item.signals, `signals_summary.top_by_excess_refusals[${index}].signals`);
    const hospital = hospitalLookup.get(`${region}\0${name}`);
    const rankingKey = `${region}\0${name}`;
    if (!hospital || rankedHospitals.has(rankingKey) || hospital.excess !== excess
      || signals.length !== hospital.signals.length || signals.some((signal) => !hospital.signals.includes(signal))
      || excess > priorExcess) throw new Error("Invalid signal ranking");
    rankedHospitals.add(rankingKey);
    priorExcess = excess;
  }

  return structuredClone(root) as unknown as Case1Analytics;
}

export async function loadCase1Analytics(): Promise<Case1Analytics> {
  if (cachedArtifact) return structuredClone(cachedArtifact);
  const info = await lstat(ARTIFACT_PATH);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_ARTIFACT_BYTES) throw new Error("Invalid Case 1 artifact file");
  const raw: unknown = JSON.parse(await readFile(ARTIFACT_PATH, "utf8"));
  cachedArtifact = validateCase1Analytics(raw);
  return structuredClone(cachedArtifact);
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: NO_STORE });
}

function fail(status: number, code: string): never {
  throw new WorkspaceAuthError(status, code);
}

async function boundary(work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    if (isWorkspaceAuthError(error)) {
      const messages: Record<string, string> = {
        BAD_REQUEST: "Query-параметры недоступны",
        FORBIDDEN: "Нет доступа",
        METHOD_NOT_ALLOWED: "Метод недоступен",
        UNAUTHORIZED: "Требуется вход",
        WORKSPACE_UNAVAILABLE: "Рабочее пространство недоступно",
      };
      return json({ code: error.code, error: messages[error.code] ?? "Нет доступа" }, error.status);
    }
    return json({ code: "CASE1_ANALYTICS_UNAVAILABLE", error: "Ведомственная аналитика недоступна" }, 503);
  }
}

export function handleCase1Analytics(req: Request, deps: Case1AnalyticsDeps = {}): Promise<Response> {
  return boundary(async () => {
    const actor = await (deps.actor ?? requireWorkspaceActor)(req);
    if (req.method !== "GET") fail(405, "METHOD_NOT_ALLOWED");
    if (new URL(req.url).search) fail(400, "BAD_REQUEST");
    if (actor.role === "doctor") fail(403, "FORBIDDEN");
    const loaded = await (deps.load ?? loadCase1Analytics)();
    return json(validateCase1Analytics(loaded));
  });
}
