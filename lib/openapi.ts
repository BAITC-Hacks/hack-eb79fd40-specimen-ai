import { apiEndpoints, apiNegativeOperations, type ApiEndpoint, type ApiField } from "./api-catalog";

type Schema = Record<string, unknown>;
type OpenApiOperation = Record<string, unknown>;

function schemaFromExample(value: unknown, strict = false): Schema {
  if (value === null) return {};
  if (Array.isArray(value)) return { type: "array", items: value.length ? schemaFromExample(value[0], strict) : {} };
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return { type: "object", additionalProperties: !strict,
      properties: Object.fromEntries(entries.map(([key, child]) => [key, schemaFromExample(child, strict)])),
      ...(strict ? { required: entries.map(([key]) => key) } : {}) };
  }
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "number" };
  return { type: typeof value };
}

function fieldSchema(field: ApiField, example: unknown): Schema {
  if (example !== undefined && typeof example === "object" && example !== null) return schemaFromExample(example, true);
  const enums = [...field.type.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
  if (enums.length) return { type: "string", enum: enums };
  if (/integer/iu.test(field.type)) return { type: "integer", ...(/1\.\.100/u.test(field.type) ? { minimum: 1, maximum: 100 } : { minimum: 0 }) };
  if (/\btrue\b/iu.test(field.type)) return { type: "boolean", const: true };
  if (/boolean/iu.test(field.type)) return { type: "boolean" };
  if (/object/iu.test(field.type)) return { type: "object", additionalProperties: false };
  return { type: "string", ...(/YYYY-MM-DD/u.test(field.type) ? { pattern: "^\\d{4}-\\d{2}-\\d{2}$" } : {}),
    ...(/16 hex/iu.test(field.type) ? { pattern: "^[a-f0-9]{16}$" } : {}),
    ...(field.name === "idempotencyKey"
      ? /string (?:8\.\.128|8–128)/iu.test(field.type) ? { minLength: 8, maxLength: 128 } : { minLength: 1, maxLength: 128 }
      : {}) };
}

function bodySchema(endpoint: ApiEndpoint): Schema | null {
  if (endpoint.request.contentType === "none" || endpoint.request.example === null) return null;
  const example = endpoint.request.example;
  const bodyFields = endpoint.request.fields.filter((field) => (field.location ?? "body") === "body");
  const properties = Object.fromEntries(bodyFields.map((field) => [field.name,
    fieldSchema(field, (example as Record<string, unknown>)[field.name])]));
  if (endpoint.id === "doctor-assessment") properties.assessment = {
    type: "object", additionalProperties: false, required: ["hypothesis", "profile", "icd10Code", "careContext"],
    properties: { hypothesis: { type: ["string", "null"] }, profile: { type: "string" }, icd10Code: { type: ["string", "null"] },
      careContext: { type: "string", enum: ["operative", "conservative", "unknown"] } },
  };
  if (endpoint.id === "registration-snapshot") properties.features = {
    type: "object", additionalProperties: false,
    required: ["bed_profile", "icd10_ref_diag_code", "referring_mo", "hospital_mo", "territorial_type", "finance_source", "referral_purpose"],
    properties: { bed_profile: { type: ["string", "null"] }, icd10_ref_diag_code: { type: "string", minLength: 1 },
      referring_mo: { type: "string", minLength: 1 }, hospital_mo: { type: "string", minLength: 1 },
      territorial_type: { type: "string", minLength: 1 }, finance_source: { type: "string", minLength: 1 },
      referral_purpose: { type: "string", minLength: 1 } },
  };
  if (endpoint.id === "referral-create") {
    properties.icd10Code = { type: ["string", "null"] };
    properties.destinationOrganization = { type: ["string", "null"] };
    properties.sourceSessionId = { type: ["string", "null"] };
  }
  if (endpoint.id === "referral-event") {
    properties.patch = { type: "object", additionalProperties: false, minProperties: 1, properties: {
      profile: { type: "string" }, icd10Code: { type: ["string", "null"] }, specialistReferred: { type: ["boolean", "null"] },
      preparationStarted: { type: "boolean" }, destinationOrganization: { type: ["string", "null"] }, sent: { type: ["boolean", "null"] },
      queue: { type: ["boolean", "null"] }, scheduledDate: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      attendance: { enum: ["attended", "not_attended", null] }, cancelled: { type: "boolean" },
    } };
    properties.reason = { type: ["string", "null"] };
    properties.occurredAt = { type: ["integer", "null"], minimum: 0 };
  }
  if (endpoint.id === "referral-examination") {
    properties.record = { type: "object", additionalProperties: false,
      required: ["requirementId", "label", "resultAvailable", "performedOn", "expiresOn", "applicability"],
      properties: { id: { type: "string" }, requirementId: { type: "string" }, label: { type: "string" },
        resultAvailable: { type: ["boolean", "null"] }, performedOn: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        expiresOn: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, applicability: { enum: ["yes", "no", "unknown"] } } };
    properties.reason = { type: ["string", "null"] };
    properties.occurredAt = { type: ["integer", "null"], minimum: 0 };
  }
  return { type: "object", additionalProperties: false, properties,
    required: bodyFields.filter((field) => field.required).map((field) => field.name) };
}

function responseSchema(endpoint: ApiEndpoint): Schema {
  if (endpoint.id === "referral-risk") return { $ref: "#/components/schemas/ReferralRiskResponse" };
  if (endpoint.id === "mis-pull") return { $ref: "#/components/schemas/MisPullResponse" };
  if (endpoint.id === "mis-ack") return { $ref: "#/components/schemas/MisAckResponse" };
  if (["patient-access", "patient-discover", "patient-package-read", "patient-package-report"].includes(endpoint.id)) {
    return { $ref: "#/components/schemas/PatientPackageResponse" };
  }
  if (endpoint.id === "patient-memo") return { $ref: "#/components/schemas/PatientMemoResponse" };
  if (["referral-create", "referral-detail", "referral-event", "referral-examination", "doctor-assessment", "patient-report-confirm", "registration-snapshot"].includes(endpoint.id)) {
    return { type: "object", additionalProperties: false, required: ["referral"], properties: { referral: { $ref: "#/components/schemas/ReferralDetail" } } };
  }
  return schemaFromExample(endpoint.success.example);
}

function security(endpoint: ApiEndpoint): readonly Record<string, readonly string[]>[] {
  if (endpoint.auth.kind === "public" || ["auth-login", "auth-logout", "chat-start", "patient-access"].includes(endpoint.id)) return [];
  if (endpoint.auth.kind === "service") return [{ MisBearer: [] }];
  if (endpoint.auth.kind === "workspace") return [{ WorkspaceCookie: [] }];
  if (endpoint.auth.kind === "patient") return endpoint.path.startsWith("/api/patient/")
    ? [{ PatientPreparationCookie: [] }] : [{ PatientChatCookie: [] }];
  if (endpoint.id === "create-link") return [{ WorkspaceCookie: [] }, { LegacyDoctorCode: [] }];
  if (endpoint.id === "auth-state") return [{}, { WorkspaceCookie: [] }];
  return [];
}

function parameters(endpoint: ApiEndpoint): Record<string, unknown>[] {
  const fields = endpoint.request.fields.filter((field) => field.location === "path" || field.location === "query" || field.location === "header");
  const byName = new Map(fields.map((field) => [field.name, field]));
  for (const name of endpoint.path.matchAll(/\{([^}]+)\}/gu)) {
    if (!byName.has(name[1])) byName.set(name[1], { name: name[1], type: "string", required: true, description: "Path identifier", location: "path" });
  }
  return [...byName.values()].map((field) => ({ name: field.name, in: field.location, required: field.location === "path" || field.required,
    description: field.description, schema: fieldSchema(field, undefined),
    ...(endpoint.pathExample?.[field.name] ? { example: endpoint.pathExample[field.name] } : {}) }));
}

function responses(endpoint: ApiEndpoint): Record<string, unknown> {
  const contentTypes = endpoint.success.contentTypes ?? ["application/json"];
  const completeExample = !["patient-access", "patient-discover", "patient-package-read", "patient-package-report",
    "referral-create", "referral-detail", "referral-event", "referral-examination", "doctor-assessment", "patient-report-confirm",
    "registration-snapshot"].includes(endpoint.id);
  const successContent = Object.fromEntries(contentTypes.map((contentType) => [contentType, contentType === "application/pdf"
    ? { schema: { type: "string", format: "binary" } }
    : { schema: responseSchema(endpoint), ...(completeExample ? { example: endpoint.success.example } : {}) }]));
  const result: Record<string, unknown> = {
    [String(endpoint.success.status)]: { description: endpoint.success.description, content: successContent },
  };
  const grouped = new Map<number, typeof endpoint.errors>();
  for (const item of endpoint.errors) grouped.set(item.status, [...(grouped.get(item.status) ?? []), item]);
  for (const [status, errors] of grouped) {
    const errorSchema = errors.every((item) => "response" in item)
      ? { oneOf: errors.map((item) => schemaFromExample(item.response, true)) }
      : { $ref: "#/components/schemas/Error" };
    result[String(status)] = {
      description: errors.map((item) => `${"code" in item ? item.code : "response"}: ${item.meaning}`).join("; "),
      content: { "application/json": { schema: errorSchema,
        examples: Object.fromEntries(errors.map((item, index) => ["code" in item ? item.code : `response${index + 1}`,
          { value: "response" in item ? item.response : { code: item.code, error: item.meaning } }])) } },
    };
  }
  return result;
}

function operation(endpoint: ApiEndpoint): OpenApiOperation {
  const body = bodySchema(endpoint);
  const params = parameters(endpoint);
  const originRequired = endpoint.method !== "GET" && endpoint.auth.kind !== "service" && endpoint.id !== "auth-state";
  return {
    operationId: endpoint.id.replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase()),
    tags: [endpoint.groupId],
    summary: endpoint.summary,
    description: endpoint.description,
    security: security(endpoint),
    ...(params.length ? { parameters: params } : {}),
    ...(body ? { requestBody: { required: true, content: { "application/json": { schema: body, example: endpoint.request.example } } } } : {}),
    responses: responses(endpoint),
    "x-demeu-auth-kind": endpoint.auth.kind,
    "x-demeu-roles": endpoint.roles ?? [],
    "x-demeu-same-origin-required": endpoint.id === "create-link" ? { workspace: true, legacyDoctorCode: false } : originRequired,
    "x-demeu-reject-unknown-query": endpoint.strictQuery === true,
    "x-demeu-rate-limit": endpoint.groupId === "mis"
      ? { policy: "fixed-window", limit: 60, windowSeconds: 60, key: "credentialId+operation", storage: "process-local" }
      : ["auth-login", "create-link"].includes(endpoint.id)
        ? { policy: "token-bucket", capacity: 10, refillWindowSeconds: 60, key: "client-ip", storage: "process-local" }
        : endpoint.id === "patient-package-report"
        ? { policy: "domain-history", changesPerMinute: 10, reportsPerRequirement: 20, reportsPerEpisode: 200, key: "patient-access" }
          : { policy: "none" },
    ...(endpoint.id === "mis-pull" ? {
      "x-demeu-required-scopes": ["events:pull"],
      "x-demeu-conditional-research-scope": "events:research is required to evaluate or receive research-only events",
    } : {}),
    ...(endpoint.id === "mis-ack" ? {
      "x-demeu-required-scopes": ["events:ack"],
      "x-demeu-conditional-research-scope": "events:research is also required when acknowledging a research-only event",
    } : {}),
    ...(endpoint.id === "health" ? {
      "x-demeu-deep-health-proof": { query: "probe=extract", header: "x-demeu-health-proof", externalMode: "required", deterministicMode: "not-required" },
    } : {}),
    ...(endpoint.id === "patient-package-read" ? {
      "x-demeu-fetch-metadata-policy": { reject: { "Sec-Fetch-Site": "cross-site" } },
      "x-demeu-query-constraints": { langRequires: { format: "pdf" }, allowedShapes: [[], ["format"], ["format", "lang"]] },
    } : {}),
  };
}

const nullableString = { type: ["string", "null"] } as const;
const dateString = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } as const;
const nullableDate = { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" } as const;

function misEnvelope(type: string, data: Schema): Schema {
  return { type: "object", additionalProperties: false,
    required: ["eventId", "sequence", "deliveryId", "deliveryAttempt", "type", "schemaVersion", "occurredAt", "subject", "data"],
    properties: {
      eventId: { type: "string", minLength: 1 }, sequence: { type: "integer", minimum: 1 }, deliveryId: { type: "string", minLength: 1 },
      deliveryAttempt: { type: "integer", minimum: 1 }, type: { const: type }, schemaVersion: { const: 1 },
      occurredAt: { type: "integer", minimum: 0 },
      subject: { type: "object", additionalProperties: false, required: ["referralId", "revision"], properties: {
        referralId: { type: "string", minLength: 1 }, revision: { type: "integer", minimum: 1 },
      } },
      data,
    } };
}

function componentSchemas(): Record<string, Schema> {
  const examinationStatus = { enum: ["present", "missing", "expired", "unknown", "not_applicable"] };
  const requirement = { type: "object", additionalProperties: false,
    required: ["requirementId", "label", "required", "status", "expiresOn"], properties: {
      requirementId: { type: "string" }, label: { type: "string" }, required: { type: ["boolean", "null"] },
      status: examinationStatus, expiresOn: nullableDate,
    } };
  const readinessData = { oneOf: [
    { type: "object", additionalProperties: false,
      required: ["state", "hypothesis", "icd10Code", "profile", "careContext", "destinationOrganization", "urgency", "redFlags", "catalogue", "evaluatedOn", "validUntil", "requirements"],
      properties: {
        state: { const: "ready" }, hypothesis: { type: "string", minLength: 1 }, icd10Code: { type: "string", minLength: 1 },
        profile: { type: "string", minLength: 1 }, careContext: { enum: ["operative", "conservative"] }, destinationOrganization: { type: "string", minLength: 1 },
        urgency: { enum: ["routine", "planned", "urgent", "emergency", null] },
        redFlags: { type: "array", items: { type: "object", additionalProperties: false, required: ["code", "label", "emergency"], properties: {
          code: { type: "string" }, label: { type: "string" }, emergency: { type: "boolean" },
        } } },
        catalogue: { type: "object", additionalProperties: false, required: ["version", "validated"], properties: {
          version: { type: "string" }, validated: { const: true },
        } },
        evaluatedOn: dateString, validUntil: nullableDate, requirements: { type: "array", items: requirement },
      } },
    { type: "object", additionalProperties: false, required: ["state", "reasonCodes", "evaluatedOn"], properties: {
      state: { const: "not_ready" }, reasonCodes: { type: "array", minItems: 1, items: { type: "string" } }, evaluatedOn: dateString,
    } },
  ] };
  const researchData = { oneOf: [
    { type: "object", additionalProperties: false,
      required: ["state", "researchOnly", "modelVersion", "inputRevision", "refusalProbabilityAmongMatureOutcomes", "workingThreshold", "riskBand", "evaluatedAt", "limitations"],
      properties: { state: { const: "high" }, researchOnly: { const: true }, modelVersion: { type: "string", minLength: 1 }, inputRevision: { type: "integer", minimum: 1 },
        refusalProbabilityAmongMatureOutcomes: { type: "number", minimum: 0, maximum: 1 }, workingThreshold: { type: "number", minimum: 0, maximum: 1 },
        riskBand: { const: "at_or_above_working_threshold" }, evaluatedAt: { type: "integer", minimum: 0 }, limitations: { type: "array", items: { type: "string" } } } },
    { type: "object", additionalProperties: false, required: ["state", "researchOnly", "modelVersion", "inputRevision", "evaluatedAt", "reasonCode"], properties: {
      state: { const: "below_threshold" }, researchOnly: { const: true }, modelVersion: { type: "string", minLength: 1 },
      inputRevision: { type: "integer", minimum: 1 }, evaluatedAt: { type: "integer", minimum: 0 }, reasonCode: { const: "BELOW_WORKING_THRESHOLD" },
    } },
    { type: "object", additionalProperties: false, required: ["state", "researchOnly", "modelVersion", "inputRevision", "evaluatedAt", "reasonCode"], properties: {
      state: { const: "unavailable" }, researchOnly: { const: true }, modelVersion: { type: "null" }, inputRevision: { type: ["integer", "null"], minimum: 1 },
      evaluatedAt: { type: "integer", minimum: 0 }, reasonCode: { enum: ["RESEARCH_EXPORT_DISABLED", "REGISTRATION_SNAPSHOT_MISSING", "INPUTS_INCOMPLETE", "ARTIFACT_UNAVAILABLE", "ARTIFACT_INVALID"] },
    } },
  ] };
  const completeness = { type: "object", additionalProperties: false,
    required: ["status", "evaluatedOn", "basis", "catalogueVersion", "catalogueAvailable", "entries"], properties: {
      status: { enum: ["complete", "incomplete", "expired", "unknown"] }, evaluatedOn: dateString,
      basis: { enum: ["scheduled_date", "today"] }, catalogueVersion: { type: "string" }, catalogueAvailable: { type: "boolean" },
      catalogueValidated: { type: "boolean" }, catalogueStatus: { enum: ["available", "unavailable"] },
      entries: { type: "array", items: { type: "object", additionalProperties: false,
        required: ["requirementId", "label", "required", "status", "expiresOn"], properties: {
          requirementId: { type: "string" }, label: { type: "string" }, required: { type: ["boolean", "null"] }, status: examinationStatus,
          expiresOn: nullableDate, provenance: { enum: ["source_documented", "profile_addition_unverified"] },
        } } },
    } };
  const examination = { type: "object", additionalProperties: false,
    required: ["id", "requirementId", "label", "resultAvailable", "performedOn", "expiresOn", "applicability"], properties: {
      id: { type: "string" }, requirementSnapshotId: { type: "string" }, requirementId: { type: "string" }, label: { type: "string" },
      resultAvailable: { type: ["boolean", "null"] }, performedOn: nullableDate, expiresOn: nullableDate,
      applicability: { enum: ["yes", "no", "unknown"] }, patientReportId: { type: "string" },
    } };
  const referralProperties: Record<string, Schema> = {
    id: { type: "string" }, organizationId: { type: "string" }, doctorId: { type: "string" }, patientLabel: { type: "string" },
    sourceSessionId: nullableString, triageSnapshot: { type: ["object", "null"], additionalProperties: true },
    doctorAssessment: { oneOf: [{ type: "null" }, { type: "object", additionalProperties: false,
      required: ["hypothesis", "profile", "icd10Code", "careContext", "authorId", "authorName", "recordedAt", "revision"], properties: {
        hypothesis: nullableString, profile: { type: "string" }, icd10Code: nullableString, careContext: { enum: ["operative", "conservative", "unknown"] },
        authorId: { type: "string" }, authorName: { type: "string" }, recordedAt: { type: "integer" }, revision: { type: "integer", minimum: 1 },
      } }] },
    registrationSnapshot: { oneOf: [{ type: "null" }, { type: "object", additionalProperties: false,
      required: ["bed_profile", "icd10_ref_diag_code", "referring_mo", "hospital_mo", "territorial_type", "finance_source", "referral_purpose"], properties: {
        bed_profile: nullableString, icd10_ref_diag_code: { type: "string", minLength: 1 }, referring_mo: { type: "string", minLength: 1 }, hospital_mo: { type: "string", minLength: 1 },
        territorial_type: { type: "string", minLength: 1 }, finance_source: { type: "string", minLength: 1 }, referral_purpose: { type: "string", minLength: 1 },
      } }] },
    requirementSnapshot: { type: "object", additionalProperties: false,
      required: ["schemaVersion", "version", "status", "source", "validated", "profiles"], properties: {
        schemaVersion: { const: 1 }, version: { type: "string" }, status: { enum: ["available", "unavailable"] }, source: nullableString,
        validated: { type: "boolean" }, scope: { oneOf: [{ type: "null" }, { type: "object", additionalProperties: false,
          required: ["population", "careSetting", "treatment"], properties: { population: { const: "adult" }, careSetting: { const: "inpatient" },
            treatment: { enum: ["operative", "conservative"] } } }] },
        profiles: { type: "array", items: { type: "object", additionalProperties: false, required: ["profile", "requirements"], properties: {
          profile: { type: "string" }, requirements: { type: "array", items: { type: "object", additionalProperties: false,
            required: ["id", "label", "required", "conditional", "validForDays"], properties: {
              id: { type: "string" }, label: { type: "string" }, required: { type: ["boolean", "null"] }, conditional: { type: "boolean" },
              validForDays: { type: ["integer", "null"] }, provenance: { enum: ["source_documented", "profile_addition_unverified"] },
            } } },
        } } },
      } },
    requirementSnapshotId: nullableString,
    profile: { type: "string" }, icd10Code: nullableString, specialistReferred: { type: ["boolean", "null"] }, preparationStarted: { type: "boolean" },
    destinationOrganization: nullableString, sent: { type: ["boolean", "null"] }, queue: { type: ["boolean", "null"] }, scheduledDate: nullableDate,
    attendance: { enum: ["attended", "not_attended", null] }, cancelled: { type: "boolean" }, createdAt: { type: "integer" }, updatedAt: { type: "integer" },
    revision: { type: "integer", minimum: 1 }, events: { type: "array", items: { type: "object", additionalProperties: true,
      required: ["id", "type", "actorId", "actorName", "source", "recordedAt", "revision"], properties: {
        id: { type: "string" }, type: { type: "string" }, actorId: { type: "string" }, actorName: { type: "string" }, source: { const: "doctor_confirmation" },
        occurredAt: { type: ["integer", "null"] }, recordedAt: { type: "integer" }, reason: nullableString, revision: { type: "integer" },
      } } }, examinations: { type: "array", items: examination }, completeness, flow: { type: "string" }, observedStageDays: { type: ["number", "null"] },
    intake: { type: ["object", "null"], additionalProperties: true }, patientReports: { type: "array", items: { type: "object", additionalProperties: true } },
  };
  const patientPackage = { type: "object", additionalProperties: false,
    required: ["accessId", "expiresAt", "state", "patientLabel", "scheduledDate", "destinationOrganization", "catalogueVersion", "catalogueSource", "catalogueValidated", "catalogueAvailable", "evaluatedOn", "confirmedCompleteness", "items"], properties: {
      accessId: { type: "string" }, expiresAt: { type: "integer" }, state: { enum: ["awaiting_referral", "preparing", "cancelled"] }, patientLabel: nullableString,
      scheduledDate: nullableDate, destinationOrganization: nullableString, catalogueVersion: nullableString, catalogueSource: nullableString,
      catalogueValidated: { type: "boolean" }, catalogueAvailable: { type: "boolean" }, careContext: { enum: ["operative", "conservative", "unknown"] },
      evaluatedOn: dateString, confirmedCompleteness: { enum: ["complete", "incomplete", "expired", "unknown"] },
      items: { type: "array", items: { type: "object", additionalProperties: false,
        required: ["requirementId", "label", "required", "conditional", "applicability", "validForDays", "confirmedStatus", "preparationStatus", "expiresOn", "expiringBeforeAdmission", "selfReport"], properties: {
          requirementId: { type: "string" }, label: { type: "string" }, required: { type: ["boolean", "null"] }, conditional: { type: "boolean" },
          applicability: { enum: ["yes", "no", "unknown"] }, validForDays: { type: ["integer", "null"] }, provenance: { enum: ["source_documented", "profile_addition_unverified"] },
          confirmedStatus: examinationStatus, preparationStatus: examinationStatus, expiresOn: nullableDate, expiringBeforeAdmission: { type: "boolean" },
          selfReport: { oneOf: [{ type: "null" }, { type: "object", additionalProperties: false,
            required: ["performedOn", "resultAvailable", "recordedAt", "revision", "confirmed"], properties: {
              performedOn: dateString, resultAvailable: { type: "boolean" }, recordedAt: { type: "integer" }, revision: { type: "integer" }, confirmed: { type: "boolean" },
            } }] },
        } } },
    } };
  return {
    Error: { type: "object", additionalProperties: true, anyOf: [{ required: ["code"] }, { required: ["error"] }], properties: {
      code: { type: "string" }, error: { type: "string" }, retry_after_ms: { type: "integer", minimum: 0 },
    } },
    ReferralRiskResponse: { type: "object", additionalProperties: false, required: ["risk"], properties: { risk: { oneOf: [
      { type: "object", additionalProperties: false, required: ["status", "researchOnly", "limitationsLabel", "modelVersion", "method", "refusalProbabilityAmongMatureOutcomes", "workingThreshold", "riskBand", "inputRevision", "inputCoverage", "warnings", "limitations"], properties: {
        status: { const: "available" }, researchOnly: { const: true }, limitationsLabel: { const: "experimental_research_only" }, modelVersion: { type: "string" }, method: { type: "string" },
        refusalProbabilityAmongMatureOutcomes: { type: "number", minimum: 0, maximum: 1 }, workingThreshold: { type: "number", minimum: 0, maximum: 1 },
        riskBand: { enum: ["below_working_threshold", "at_or_above_working_threshold"] }, inputRevision: { type: "integer", minimum: 1 },
        inputCoverage: { type: "object", additionalProperties: false,
          required: ["bed_profile", "icd10_ref_diag_code", "referring_mo", "hospital_mo", "territorial_type", "finance_source", "referral_purpose"],
          properties: Object.fromEntries(["bed_profile", "icd10_ref_diag_code", "referring_mo", "hospital_mo", "territorial_type", "finance_source", "referral_purpose"]
            .map((name) => [name, { enum: ["frequent", "fallback_infrequent_or_unseen", "unknown_all_zero", "missing"] }])) },
        warnings: { type: "array", items: { type: "string" } }, limitations: { type: "array", items: { type: "string" } },
      } },
      { type: "object", additionalProperties: false, required: ["status", "researchOnly", "reason", "missingInputs", "inputRevision"], properties: {
        status: { const: "unavailable" }, researchOnly: { const: true }, reason: { enum: ["REGISTRATION_SNAPSHOT_MISSING", "INPUTS_INCOMPLETE", "ARTIFACT_UNAVAILABLE"] },
        missingInputs: { type: "array", uniqueItems: true, items: { enum: ["bed_profile", "icd10_ref_diag_code", "referring_mo", "hospital_mo", "territorial_type", "finance_source", "referral_purpose"] } }, inputRevision: { type: ["integer", "null"] },
      } },
    ] } } },
    MisEvent: { oneOf: [misEnvelope("referral.readiness.changed", readinessData), misEnvelope("referral.research_risk.changed", researchData)] },
    MisPullResponse: { type: "object", additionalProperties: false, required: ["events", "retryAfterMs"], properties: {
      events: { type: "array", items: { $ref: "#/components/schemas/MisEvent" } }, retryAfterMs: { type: "integer", minimum: 0 },
    } },
    MisAckResponse: { type: "object", additionalProperties: false, required: ["eventId", "acked", "ackedAt", "replayed"], properties: {
      eventId: { type: "string" }, acked: { const: true }, ackedAt: { type: "integer", minimum: 0 }, replayed: { type: "boolean" },
    } },
    PatientPackage: patientPackage,
    PatientPackageResponse: { type: "object", additionalProperties: false, required: ["package"], properties: { package: patientPackage } },
    PatientMemoResponse: { type: "object", additionalProperties: false, required: ["memo"], properties: { memo: { type: "object", additionalProperties: false,
      required: ["patientLabel", "scheduledDate", "destinationOrganization", "catalogueAvailable", "items"], properties: {
        patientLabel: { type: "string" }, scheduledDate: nullableDate, destinationOrganization: nullableString, catalogueAvailable: { type: "boolean" },
        careContext: { enum: ["operative", "conservative", "unknown"] }, items: { type: "array", items: { type: "object", additionalProperties: false,
          required: ["label", "status", "expiresOn"], properties: { label: { type: "string" }, status: examinationStatus, expiresOn: nullableDate,
            provenance: { enum: ["source_documented", "profile_addition_unverified"] } } } },
      } } } },
    ReferralDetail: { type: "object", additionalProperties: false,
      required: ["id", "organizationId", "doctorId", "patientLabel", "sourceSessionId", "triageSnapshot", "registrationSnapshot", "requirementSnapshot", "requirementSnapshotId", "profile", "icd10Code", "specialistReferred", "preparationStarted", "destinationOrganization", "sent", "queue", "scheduledDate", "attendance", "cancelled", "createdAt", "updatedAt", "revision", "events", "examinations", "completeness", "flow", "observedStageDays"],
      properties: referralProperties },
  };
}

export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const endpoint of apiEndpoints) {
    (paths[endpoint.path] ??= {})[endpoint.method.toLowerCase()] = operation(endpoint);
  }
  for (const negative of apiNegativeOperations) {
    const path = paths[negative.path] ??= {};
    path[negative.method.toLowerCase()] = {
      operationId: `unsupported${negative.method}${negative.path.replace(/[^A-Za-z0-9]+/gu, "_")}`,
      summary: "Метод явно не поддерживается",
      security: negative.path.includes("/reference/") || negative.path.includes("/analytics/") || negative.path.includes("/referrals/")
        ? [{ WorkspaceCookie: [] }] : [],
      responses: Object.fromEntries(negative.statuses.map((status) => [String(status), {
        description: status === 405 ? "METHOD_NOT_ALLOWED" : status === 401 ? "UNAUTHORIZED" : status === 403 ? "FORBIDDEN" : "WORKSPACE_UNAVAILABLE",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      }])),
      "x-demeu-negative-operation": true,
      "x-demeu-auth-kind": "workspace",
      "x-demeu-roles": negative.path.includes("/analytics/") ? ["owner", "analyst"]
        : negative.path.includes("registration-snapshot") ? ["doctor"]
          : negative.path.endsWith("/risk") ? ["owner", "doctor"] : ["owner", "doctor", "analyst"],
      "x-demeu-same-origin-required": negative.method === "POST" && negative.path === "/api/referrals/{id}/risk",
      "x-demeu-reject-unknown-query": false,
      "x-demeu-rate-limit": { policy: "none" },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Demeu API", version: "1.0.0", description: "Фактический контракт Demeu. MIS использует pull + ACK; live external acceptance remains separate." },
    servers: [{ url: "https://specimen-ai.govtech-kz.com", description: "Configured production origin; verify exact release before use." }],
    tags: [
      { name: "system" }, { name: "patient" }, { name: "auth" }, { name: "intakes" }, { name: "referrals" },
      { name: "analytics" }, { name: "models" }, { name: "reference" }, { name: "mis" },
    ],
    paths,
    components: {
      securitySchemes: {
        WorkspaceCookie: { type: "apiKey", in: "cookie", name: "__Host-demeu_workspace", "x-demeu-development-name": "demeu_workspace" },
        PatientChatCookie: { type: "apiKey", in: "cookie", name: "__Secure-demeu_patient_{sha256(sessionId)[0:24]}",
          "x-demeu-cookie-name-template": "__Secure-demeu_patient_{sha256(sessionId).slice(0,24)}", "x-demeu-development-name-template": "demeu_patient_{sha256(sessionId).slice(0,24)}",
          "x-demeu-client-guidance": "Use a cookie jar; the server issues the exact HttpOnly cookie name." },
        PatientPreparationCookie: { type: "apiKey", in: "cookie", name: "__Secure-demeu_preparation_{sha256(accessId)[0:24]}",
          "x-demeu-cookie-name-template": "__Secure-demeu_preparation_{sha256(accessId).slice(0,24)}", "x-demeu-development-name-template": "demeu_preparation_{sha256(accessId).slice(0,24)}",
          "x-demeu-client-guidance": "Use a cookie jar; the server issues the exact HttpOnly cookie name." },
        LegacyDoctorCode: { type: "apiKey", in: "header", name: "x-doctor-code" },
        MisBearer: { type: "http", scheme: "bearer", bearerFormat: "<credentialId>.<43-char-base64url-secret>" },
      },
      schemas: componentSchemas(),
    },
  };
}

export function openApiJson(): string { return `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`; }
