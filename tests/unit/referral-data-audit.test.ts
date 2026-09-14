import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditReferralData } from "../../scripts/audit-referral-data";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function fixture(text: string | Buffer, columns: Record<string, string> = { period: "period", region: "region", test_type: "test", test_count: "count" }) {
  const directory = await mkdtemp(path.join(tmpdir(), "demeu-data-audit-"));
  directories.push(directory);
  await writeFile(path.join(directory, "input.csv"), text);
  return auditReferralData({ sources: [{ source: "eip", file: "input.csv", columns }] }, directory);
}

describe("organizer data readiness metadata audit", () => {
  it("defaults to missing data for every source and blocks every model", async () => {
    const report = await auditReferralData();
    expect(report.status).toBe("blocked");
    expect(report.sources.every((source) => source.reason === "missing_data")).toBe(true);
    expect(report.tasks.map((task) => task.task)).toEqual(["D1", "D2", "B3", "D4"]);
    expect(report.tasks.every((task) => task.status === "blocked" && task.pending_reviews.length > 0)).toBe(true);
  });

  it("accepts UTF-8 quoted CSV without exposing patient text or treating zero as empty", async () => {
    const report = await fixture('\uFEFFПериод,Регион,Тип,Количество,private\r\n2026-01,Тест,"тип, один",0,"SECRET-PATIENT\nquoted ""value"""\r\n2026-02,Тест,тип,,hidden\r\n', { period: "Период", region: "Регион", test_type: "Тип", test_count: "Количество" });
    const source = report.sources.find((item) => item.source === "eip")!;
    expect(source).toMatchObject({ row_count: 2, status: "needs_semantic_review", empty_counts: { test_count: 1 } });
    expect(source.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.tasks.find((task) => task.task === "D2")?.status).toBe("needs_semantic_review");
    const serialized = JSON.stringify(report);
    for (const secret of ["SECRET-PATIENT", "hidden", "private", "Период", "input.csv", "2026-01", "тип, один"]) expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('"ready"');
  });

  it("does not infer semantic fields from matching headers and blocks all-empty targets", async () => {
    const unmapped = await fixture("period,region,test,count\n2026-01,R,T,4\n", {});
    expect(unmapped.sources[2].reason).toBe("missing_mapping");
    const empty = await fixture("period,region,test,count\n2026-01,R,T,\n");
    expect(empty.tasks.find((task) => task.task === "D2")).toMatchObject({ status: "blocked", all_empty_fields: ["test_count"] });
    const missing = await fixture("period,region,test,count\n2026-01,R,T,1\n", { test_count: "SECRET_HEADER" });
    expect(missing.sources[2].missing_columns).toEqual(["test_count"]);
    expect(JSON.stringify(missing)).not.toContain("SECRET_HEADER");
  });

  it.each([
    ['a,a\n1,2\n', "invalid_header"],
    ['a,b\n"unclosed,b', "invalid_csv"],
    ['a,b\n"closed"extra,b', "invalid_csv"],
    ['a,b\n1,2,3\n', "invalid_row_width"],
    ['a,b\r1,2', "invalid_csv"],
    ['a,b\n', "empty_data"],
  ])("rejects malformed or empty input without disclosing its content", async (csv, reason) => {
    const report = await fixture(csv, { test_count: "a" });
    expect(report.sources[2]).toMatchObject({ status: "blocked", reason });
  });

  it("rejects oversized and invalid UTF-8 inputs", async () => {
    expect((await fixture(Buffer.alloc(10 * 1024 * 1024 + 1))).sources[2].reason).toBe("input_too_large");
    expect((await fixture(Buffer.from([0xff, 0xfe]))).sources[2].reason).toBe("invalid_utf8");
  });

  it("reports only safe failure codes for missing files and unsupported formats", async () => {
    const report = await auditReferralData({ sources: [
      { source: "is_bg", file: "/MISSING-PRIVATE-PATH.csv", columns: {} },
      { source: "eip", file: "/SECRET-PATH.xlsx", columns: {} },
    ] });
    expect(report.sources[0].reason).toBe("unreadable_file");
    expect(report.sources[2].reason).toBe("unsupported_format");
    expect(JSON.stringify(report)).not.toContain("PATH");
  });

  it("rejects ambiguous mappings and unknown configuration without echoing values", async () => {
    await expect(auditReferralData({ sources: [{ source: "eip", file: "secret", columns: { period: "same", region: "same" } }] })).rejects.toThrow("invalid_config");
    await expect(auditReferralData({ sources: [{ source: "private-source", file: "secret", columns: {} }] })).rejects.toThrow("invalid_config");
  });
});
