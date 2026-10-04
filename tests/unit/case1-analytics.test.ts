import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  handleCase1Analytics,
  loadCase1Analytics,
  validateCase1Analytics,
  type Case1Analytics,
} from "../../lib/case1-analytics";
import { WorkspaceAuthError, type WorkspaceActor } from "../../lib/workspace-auth";
import { selectHospitals, sortRegions } from "../../app/workspace/analytics/view-model";

let artifact: unknown;

beforeAll(async () => {
  artifact = JSON.parse(await readFile(resolve(process.cwd(), "data/case1/aggregates.json"), "utf8"));
});

function clone(): Case1Analytics {
  return structuredClone(artifact) as Case1Analytics;
}

function actor(role: WorkspaceActor["role"]): WorkspaceActor {
  return { id: `${role}-1`, displayName: role, role, organizationId: "org-1" };
}

function request(method = "GET", suffix = ""): Request {
  return new Request(`http://localhost/api/analytics/case1${suffix}`, { method });
}

describe("Case 1 aggregate artifact", () => {
  it("accepts the shipped snapshot, including disclosed sparse and anomalous wait values", () => {
    const result = validateCase1Analytics(artifact);
    expect(result).toMatchObject({ schema_version: 1, status: "offline_snapshot" });
    expect(result.national.referrals).toBe(767_130);
    expect(result.regions).toHaveLength(20);
    expect(result.hospitals).toHaveLength(642);
    expect(result.profiles).toHaveLength(58);
    expect(result.factors).toHaveLength(21);
    expect(result.limitations).toHaveLength(6);
    expect(result.source.inputs[0].sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.hospitals.some((hospital) => hospital.external_24h === null)).toBe(true);
    expect(result.hospitals.some((hospital) => hospital.long_wait_vs_expected === undefined)).toBe(true);
    expect(result.hospitals.some((hospital) => (hospital.wait_median_days ?? 0) < 0)).toBe(true);
  });

  it("does not freeze published collection sizes in runtime validation", () => {
    const changed = clone();
    const removable = changed.hospitals.findIndex((hospital) => hospital.signals.length === 0
      && !changed.signals_summary.top_by_excess_refusals.some((entry) => entry.name === hospital.name && entry.region === hospital.region));
    changed.hospitals.splice(removable, 1);
    changed.forecast.hospitals -= 1;
    changed.signals_summary.hospitals_checked -= 1;
    expect(validateCase1Analytics(changed).hospitals).toHaveLength(641);
  });

  it("accepts error percentages above 100 while enforcing ordinary percentages", () => {
    const changed = clone();
    changed.forecast.model.wape_pct = 125;
    changed.forecast.model.median_abs_pct_error = 220;
    expect(validateCase1Analytics(changed).forecast.model.wape_pct).toBe(125);
    changed.national.refusal_pct = 101;
    expect(() => validateCase1Analytics(changed)).toThrow();
  });

  it.each([
    ["unexpected nested key", (value: Case1Analytics) => { Object.assign(value.hospitals[0], { unexpected: true }); }],
    ["invalid month", (value: Case1Analytics) => { const region = value.regions[0]; const first = Object.keys(region.monthly_referrals)[0]; const monthCount = region.monthly_referrals[first]; delete region.monthly_referrals[first]; region.monthly_referrals["2025-13"] = monthCount; }],
    ["wrong region pair", (value: Case1Analytics) => { value.hospitals[0].region = value.regions.find((region) => region.code !== value.hospitals[0].region_code)?.name ?? "unknown"; }],
    ["duplicate ranking", (value: Case1Analytics) => { value.signals_summary.top_by_excess_refusals.push(structuredClone(value.signals_summary.top_by_excess_refusals[0])); }],
    ["mismatched ranking signals", (value: Case1Analytics) => { value.signals_summary.top_by_excess_refusals[0].signals = []; }],
    ["count beyond parent", (value: Case1Analytics) => { value.hospitals[0].hospitalized = value.hospitals[0].referrals + 1; }],
    ["disagreeing signal summary", (value: Case1Analytics) => { value.signals_summary.refusal_above_expected += 1; }],
    ["unsorted weeks", (value: Case1Analytics) => { [value.weekly[0], value.weekly[1]] = [value.weekly[1], value.weekly[0]]; }],
    ["unsafe source filename", (value: Case1Analytics) => { value.source.inputs[0].file = "../raw.csv"; }],
  ])("rejects %s", (_label, mutate) => {
    const changed = clone();
    mutate(changed);
    expect(() => validateCase1Analytics(changed)).toThrow();
  });

  it("returns defensive copies from the cached loader", async () => {
    const first = await loadCase1Analytics();
    const original = first.national.referrals;
    (first.national as { referrals: number }).referrals = 0;
    expect((await loadCase1Analytics()).national.referrals).toBe(original);
  });
});

describe("Case 1 API boundary", () => {
  it.each(["owner", "analyst"] as const)("allows %s and returns the snapshot with no-store headers", async (role) => {
    const response = await handleCase1Analytics(request(), { actor: async () => actor(role), load: async () => artifact });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await response.json() as Case1Analytics).hospitals).toHaveLength(642);
  });

  it("denies doctors before loading data", async () => {
    const load = vi.fn(async () => artifact);
    const response = await handleCase1Analytics(request(), { actor: async () => actor("doctor"), load });
    expect(response.status).toBe(403);
    expect(load).not.toHaveBeenCalled();
  });

  it("authenticates before method and query validation and never loads rejected requests", async () => {
    const order: string[] = [];
    const load = vi.fn(async () => { order.push("load"); return artifact; });
    const unauthenticated = await handleCase1Analytics(request("POST", "?x=1"), {
      actor: async () => { order.push("actor"); throw new WorkspaceAuthError(401, "UNAUTHORIZED"); }, load,
    });
    expect(unauthenticated.status).toBe(401);
    expect(order).toEqual(["actor"]);
    const badMethod = await handleCase1Analytics(request("HEAD"), { actor: async () => actor("owner"), load });
    const badQuery = await handleCase1Analytics(request("GET", "?x=1"), { actor: async () => actor("analyst"), load });
    expect([badMethod.status, badQuery.status]).toEqual([405, 400]);
    expect(load).not.toHaveBeenCalled();
  });

  it("fails closed with stable headers when the artifact is unavailable", async () => {
    const response = await handleCase1Analytics(request(), { actor: async () => actor("owner"), load: async () => { throw new Error("missing"); } });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "CASE1_ANALYTICS_UNAVAILABLE" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("Case 1 view model and packaging", () => {
  it("filters and sorts a copy without mutating API arrays", () => {
    const data = validateCase1Analytics(artifact);
    const before = data.hospitals.map((hospital) => hospital.name);
    const signal = data.hospitals.find((hospital) => hospital.signals.length)?.signals[0] ?? "refusal_above_expected";
    const selected = selectHospitals(data.hospitals, { query: "", regionCode: "", signal, sort: "excess" });
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.every((hospital) => hospital.signals.includes(signal))).toBe(true);
    expect(data.hospitals.map((hospital) => hospital.name)).toEqual(before);
    expect(sortRegions(data.regions, "name")).not.toBe(data.regions);
  });

  it("keeps doctor and department data origins separated in source", async () => {
    const page = await readFile(resolve(process.cwd(), "app/workspace/analytics/page.tsx"), "utf8");
    const department = await readFile(resolve(process.cwd(), "app/workspace/analytics/department.tsx"), "utf8");
    expect(page).toContain('actor.role === "doctor" ? <DoctorAnalytics /> : <DepartmentAnalytics />');
    expect(page).toContain('data-data-origin="synthetic-demo"');
    expect(department).toContain('useInsightData<Case1Analytics>("/api/analytics/case1")');
    expect(department).not.toContain("synthetic-demo");
    expect(department).toContain("Итоговый вариант выбран после сравнения на марте");
    expect(department).toContain("value < 0 ? \"Не рассчитано\"");
    expect(department).toContain("сигнал отказов использует все сопоставимые направления");
    expect(department).toContain("Порог сигнала применяется до округления интервала");
    for (const label of ["Регион", "Сигнал", "Сортировка регионов", "Сортировка организаций"]) {
      expect(department).toContain(`aria-label="${label}"`);
    }
  });

  it("packages the aggregate artifact in the standalone image", async () => {
    const dockerfile = await readFile(resolve(process.cwd(), "Dockerfile"), "utf8");
    expect(dockerfile).toContain("/app/data/case1/aggregates.json ./data/case1/aggregates.json");
  });
});
