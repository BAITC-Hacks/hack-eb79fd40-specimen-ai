import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { apiEndpoints, apiNegativeOperations } from "../../lib/api-catalog";
import { buildOpenApiDocument, openApiJson } from "../../lib/openapi";
import { MemoryReferralRepository, ReferralService } from "../../lib/referrals/service";

type Json = Record<string, unknown>;
const document = buildOpenApiDocument();
const paths = document.paths as Record<string, Record<string, Json>>;
const schemas = (document.components as Json).schemas as Record<string, Json>;
const operation = (path: string, method: string) => paths[path][method] as Json;
interface JsonValidator { (value: unknown): boolean; errors?: unknown }
interface AjvLike { compile(schema: unknown): JsonValidator }
const Ajv = createRequire(import.meta.url)("ajv") as new (options?: Record<string, unknown>) => AjvLike;
function validator(schema: Json): JsonValidator {
  const bundled = JSON.parse(JSON.stringify({ ...schema, definitions: schemas })
    .replaceAll("#/components/schemas/", "#/definitions/")) as Json;
  return new Ajv({ allErrors: true, schemaId: "auto" }).compile(bundled);
}

describe("OpenAPI 3.1 contract", () => {
  it("covers the actual route inventory, including deliberate unsupported methods", () => {
    expect(document.openapi).toBe("3.1.0");
    expect(apiEndpoints).toHaveLength(38);
    expect(apiNegativeOperations).toHaveLength(4);
    for (const endpoint of apiEndpoints) expect(operation(endpoint.path, endpoint.method.toLowerCase()).operationId).toBeTruthy();
    for (const negative of apiNegativeOperations) {
      const item = operation(negative.path, negative.method.toLowerCase());
      expect(item["x-demeu-negative-operation"]).toBe(true);
      expect(Object.keys(item.responses as Json).some((status) => status.startsWith("2"))).toBe(false);
    }
  });

  it("documents exact production cookie naming, service scopes, query and fetch-metadata gates", () => {
    const schemes = (document.components as Json).securitySchemes as Record<string, Json>;
    expect(schemes.WorkspaceCookie).toMatchObject({ name: "__Host-demeu_workspace", "x-demeu-development-name": "demeu_workspace" });
    expect(schemes.PatientChatCookie["x-demeu-cookie-name-template"]).toBe("__Secure-demeu_patient_{sha256(sessionId).slice(0,24)}");
    expect(schemes.PatientPreparationCookie["x-demeu-development-name-template"]).toBe("demeu_preparation_{sha256(accessId).slice(0,24)}");
    expect(operation("/api/mis/v1/events/pull", "post")).toMatchObject({
      security: [{ MisBearer: [] }], "x-demeu-required-scopes": ["events:pull"], "x-demeu-reject-unknown-query": true,
      "x-demeu-rate-limit": { policy: "fixed-window", limit: 60, windowSeconds: 60, key: "credentialId+operation" },
    });
    expect(operation("/api/mis/v1/events/{eventId}/ack", "post")["x-demeu-required-scopes"]).toEqual(["events:ack"]);
    expect(operation("/api/patient/{id}/package", "get")["x-demeu-fetch-metadata-policy"])
      .toEqual({ reject: { "Sec-Fetch-Site": "cross-site" } });
    expect(operation("/api/patient/{id}/package", "get")["x-demeu-query-constraints"])
      .toEqual({ langRequires: { format: "pdf" }, allowedShapes: [[], ["format"], ["format", "lang"]] });
    expect(operation("/api/referrals/{id}/patient-memo", "get")["x-demeu-reject-unknown-query"]).toBe(false);
  });

  it("models strict consequential requests, nullable fields and alternate valid patches", () => {
    const pullBody = (((operation("/api/mis/v1/events/pull", "post").requestBody as Json).content as Json)["application/json"] as Json).schema as Json;
    expect(pullBody).toMatchObject({ additionalProperties: false, properties: { limit: { type: "integer", minimum: 1, maximum: 100 } } });
    const assessment = (((operation("/api/referrals/{id}/doctor-assessment", "post").requestBody as Json).content as Json)["application/json"] as Json).schema as Json;
    expect(((assessment.properties as Json).assessment as Json)).toMatchObject({ additionalProperties: false,
      required: ["hypothesis", "profile", "icd10Code", "careContext"] });
    expect((((assessment.properties as Json).assessment as Json).properties as Json).careContext).toEqual({ type: "string", enum: ["operative", "conservative", "unknown"] });
    const event = (((operation("/api/referrals/{id}/events", "post").requestBody as Json).content as Json)["application/json"] as Json).schema as Json;
    const patchSchema = (event.properties as Json).patch as Json;
    expect(patchSchema).toMatchObject({ additionalProperties: false, minProperties: 1 });
    expect(Object.keys(patchSchema.properties as Json)).toEqual(expect.arrayContaining(["scheduledDate", "cancelled", "attendance", "queue"]));
    expect(((patchSchema.properties as Json).scheduledDate as Json).type).toEqual(["string", "null"]);
    const exam = (((operation("/api/referrals/{id}/examinations", "post").requestBody as Json).content as Json)["application/json"] as Json).schema as Json;
    expect(((((exam.properties as Json).record as Json).properties as Json).resultAvailable as Json).type).toEqual(["boolean", "null"]);
  });

  it("couples each MIS event type to one closed data family and exposes sequence", () => {
    const variants = schemas.MisEvent.oneOf as Json[];
    expect(variants).toHaveLength(2);
    expect(variants.map((variant) => ((variant.properties as Json).type as Json).const)).toEqual([
      "referral.readiness.changed", "referral.research_risk.changed",
    ]);
    for (const variant of variants) {
      expect(variant.additionalProperties).toBe(false);
      expect(variant.required).toContain("sequence");
      const data = (variant.properties as Json).data as Json;
      for (const branch of data.oneOf as Json[]) expect(branch.additionalProperties).toBe(false);
    }
    const research = (variants[1].properties as Json).data as Json;
    expect((research.oneOf as Json[]).map((branch) => ((branch.properties as Json).state as Json).const)).toEqual(["high", "below_threshold", "unavailable"]);
  });

  it("describes complete B3/package/PDF/error boundaries without false closed examples", () => {
    const risk = (((schemas.ReferralRiskResponse.properties as Json).risk as Json).oneOf as Json[]);
    const availableCoverage = (((risk[0].properties as Json).inputCoverage as Json));
    expect(availableCoverage).toMatchObject({ additionalProperties: false,
      required: ["bed_profile", "icd10_ref_diag_code", "referring_mo", "hospital_mo", "territorial_type", "finance_source", "referral_purpose"] });
    expect((schemas.PatientPackage.properties as Json).items).toBeTruthy();
    for (const path of ["/api/patient/{id}/package", "/api/referrals/{id}/patient-memo"]) {
      const content = (((operation(path, "get").responses as Json)["200"] as Json).content as Json);
      expect(content["application/pdf"]).toMatchObject({ schema: { type: "string", format: "binary" } });
    }
    expect(schemas.Error).toMatchObject({ additionalProperties: true });
    expect(schemas.Error.anyOf).toEqual([{ required: ["code"] }, { required: ["error"] }]);
  });

  it("validates representative runtime DTOs and rejects a cross-family MIS payload", async () => {
    const referralService = new ReferralService(new MemoryReferralRepository(), { now: () => 1_791_100_000_000, id: () => crypto.randomUUID() });
    const referral = await referralService.create({ id: "doctor-a", displayName: "Врач", role: "doctor", organizationId: "org-a" },
      { patientLabel: "Contract fixture", profile: "Хирургический", idempotencyKey: "openapi-runtime-referral" });
    const referralSchema = ((((operation("/api/referrals/{id}", "get").responses as Json)["200"] as Json).content as Json)["application/json"] as Json).schema as Json;
    const validateReferral = validator(referralSchema);
    expect(validateReferral({ referral }), JSON.stringify(validateReferral.errors)).toBe(true);

    const validatePull = validator(schemas.MisPullResponse);
    const readinessEvent = { eventId: "event-1", sequence: 1, deliveryId: "delivery-1", deliveryAttempt: 1,
      type: "referral.readiness.changed", schemaVersion: 1, occurredAt: 1,
      subject: { referralId: "ref-1", revision: 1 }, data: { state: "not_ready", reasonCodes: ["SCHEDULE_MISSING"], evaluatedOn: "2026-10-04" } };
    expect(validatePull({ events: [readinessEvent], retryAfterMs: 300000 }), JSON.stringify(validatePull.errors)).toBe(true);
    expect(validatePull({ events: [{ ...readinessEvent, data: { state: "high", researchOnly: true, modelVersion: "v1", inputRevision: 1,
      refusalProbabilityAmongMatureOutcomes: 0.8, workingThreshold: 0.4, riskBand: "at_or_above_working_threshold", evaluatedAt: 1,
      limitations: ["test"] } }], retryAfterMs: 300000 })).toBe(false);
  });

  it("keeps the committed artifact byte-for-byte deterministic and privacy safe", async () => {
    expect(await readFile("docs/openapi.json", "utf8")).toBe(openApiJson());
    const serialized = openApiJson();
    expect(serialized).not.toMatch(/passwordHash|secretHash|capabilityHash|telegramChatId|registrationSnapshot"\s*:\s*\{\s*"bed_profile/iu);
    expect(serialized).not.toContain("/home/almaz");
  });
});
