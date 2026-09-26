import { describe, expect, it } from "vitest";
import {
  buildExaminationRequirementsReference,
  handleExaminationRequirementsReference,
  type ReferenceApiDeps,
} from "../../lib/reference-api";
import { DEFAULT_REQUIREMENTS } from "../../lib/referrals/requirements";
import { WorkspaceAuthError, type WorkspaceActor } from "../../lib/workspace-auth";

const BASE = "https://workspace.example.test/api/reference/examination-requirements";
const roles = ["owner", "doctor", "analyst"] as const;

function request(path = BASE, method = "GET"): Request {
  return new Request(path, { method });
}

function deps(role: WorkspaceActor["role"] = "doctor"): ReferenceApiDeps {
  return {
    actor: async () => ({
      id: `${role}-test`,
      displayName: `Test ${role}`,
      role,
      organizationId: "clinic-a",
    }),
  };
}

describe("examination requirements reference catalogue", () => {
  it("catalogue exposes the schema-validated runtime loader with exact aggregate counts", async () => {
    const response = await handleExaminationRequirementsReference(request(), deps());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const payload = await response.json();
    expect(payload.schemaVersion).toBe(1);
    expect(payload.catalogue).toEqual({
      id: "b1-examination-requirements-v1",
      version: "2025-02-17-order-9-appendix-5",
      status: "available",
      source: DEFAULT_REQUIREMENTS.source,
      scope: { population: "adult", careSetting: "inpatient", treatment: "operative" },
      validated: false,
      validationStatus: "unvalidated",
    });
    expect(payload.summary).toEqual({
      profileCount: 8,
      requirementOccurrenceCount: 148,
      uniqueRequirementCount: 57,
    });
    expect(payload.profiles).toHaveLength(8);
    expect(payload.profiles.flatMap((profile: { requirements: unknown[] }) => profile.requirements)).toHaveLength(148);
  });
});

describe("examination requirements reference validation and shape", () => {
  it("validation preserves unverified state and nullable requirement semantics", () => {
    const payload = buildExaminationRequirementsReference();
    const requirements = payload.profiles.flatMap((profile) => profile.requirements);

    expect(payload.catalogue.validated).toBe(false);
    expect(payload.catalogue.validationStatus).toBe("unvalidated");
    expect(requirements.some((entry) => entry.validForDays === null)).toBe(true);
    expect(requirements.some((entry) => entry.required === true && !entry.conditional)).toBe(true);
    expect(requirements.some((entry) => entry.required === false && entry.conditional)).toBe(true);
    for (const requirement of requirements) {
      expect(Object.keys(requirement).sort()).toEqual(["conditional", "id", "label", "required", "validForDays"]);
      expect(requirement.validForDays === null || Number.isSafeInteger(requirement.validForDays)).toBe(true);
      expect(requirement.required === null || typeof requirement.required === "boolean").toBe(true);
    }
  });

  it("shape contains no account, patient, secret, or raw path fields", async () => {
    const payload = await (await handleExaminationRequirementsReference(request(), deps("owner"))).json();
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toMatch(/patientLabel|doctorToken|telegramChatId|passwordHash|organizationId/u);
    expect(serialized).not.toContain("/home/");
    expect(serialized).not.toMatch(/sk-ant-|bot[0-9]{8,}:/u);
  });

  it("validation fails closed when an injected catalogue is malformed", async () => {
    const response = await handleExaminationRequirementsReference(request(), {
      ...deps(),
      catalogue: { ...DEFAULT_REQUIREMENTS, profiles: "not-a-list" },
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      code: "REFERENCE_CATALOGUE_UNAVAILABLE",
      error: "Справочник обследований недоступен",
    });
  });
});

describe("examination requirements reference authentication and method", () => {
  it.each(roles)("authentication allows the %s workspace role", async (role) => {
    const response = await handleExaminationRequirementsReference(request(), deps(role));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    [401, "UNAUTHORIZED", "Требуется вход"],
    [503, "WORKSPACE_UNAVAILABLE", "Рабочее пространство недоступно"],
  ] as const)("authentication preserves the %i fail-closed response", async (status, code, message) => {
    const response = await handleExaminationRequirementsReference(request(), {
      actor: async () => { throw new WorkspaceAuthError(status, code); },
      catalogue: null,
    });
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ code, error: message });
  });

  it.each(["POST", "HEAD"])("method rejects the non-GET %s request before loading the catalogue", async (method) => {
    const response = await handleExaminationRequirementsReference(request(BASE, method), {
      ...deps(),
      catalogue: null,
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ code: "METHOD_NOT_ALLOWED", error: "Метод недоступен" });
  });

  it("method rejects every query parameter before loading the catalogue", async () => {
    const response = await handleExaminationRequirementsReference(request(`${BASE}?profile=x`), {
      ...deps(),
      catalogue: null,
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ code: "BAD_REQUEST", error: "Query-параметры недоступны" });
  });

  it("authentication runs before method and query validation", async () => {
    const unauthorized: ReferenceApiDeps = {
      actor: async () => { throw new WorkspaceAuthError(401, "UNAUTHORIZED"); },
      catalogue: null,
    };
    const responses = await Promise.all([
      handleExaminationRequirementsReference(request(BASE, "POST"), unauthorized),
      handleExaminationRequirementsReference(request(`${BASE}?profile=x`), unauthorized),
    ]);
    expect(responses.map((response) => response.status)).toEqual([401, 401]);
  });
});
