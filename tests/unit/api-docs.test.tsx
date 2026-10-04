// @vitest-environment jsdom

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ApiDocsPage, { dynamic as apiDocsRenderingMode } from "../../app/api-docs/page";
import { ApiDocsPortal } from "../../app/api-docs/portal";
import { apiEndpoints, apiGroups, apiNegativeOperations, codeExample, endpointOperation, flowStories } from "../../lib/api-catalog";
import { apiDocsBaseUrl } from "../../lib/api-docs-origin";

const doctorAccessForTest = {
  personalRecords: "own",
  aggregateRecords: "own",
  aggregatePrivacy: "direct",
};

function routeFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? routeFiles(path) : entry === "route.ts" ? [path] : [];
  });
}

function implementedOperations(): string[] {
  const operations: string[] = [];
  for (const filename of routeFiles("app/api")) {
    const source = readFileSync(filename, "utf8");
    const route = `/${relative("app", filename).split(sep).slice(0, -1).join("/")}`
      .replace(/\[([^\]]+)\]/gu, "{$1}");
    const methods = new Set<string>();
    for (const match of source.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|DELETE|HEAD)\b|export\s+const\s+(GET|POST|DELETE|HEAD)\s*=/gu)) {
      methods.add(match[1] ?? match[2]);
    }
    for (const method of methods) operations.push(`${method} ${route}`);
  }
  const negative = new Set(apiNegativeOperations.map((entry) => `${entry.method} ${entry.path}`));
  expect([...negative].sort()).toEqual(operations.filter((operation) => negative.has(operation)).sort());
  return operations.filter((operation) => !negative.has(operation)).sort();
}

describe("Demeu API portal", () => {
  it("renders at runtime so production examples use the deployed origin", () => {
    expect(apiDocsRenderingMode).toBe("force-dynamic");
    vi.stubEnv("APP_BASE_URL", "https://api.example.test/");

    try {
      expect(renderToStaticMarkup(<ApiDocsPage />)).toContain("https://api.example.test");
      expect(apiDocsBaseUrl("https://api.example.test/deploy/path?ignored=true")).toBe("https://api.example.test");
      expect(apiDocsBaseUrl("https://user:secret@api.example.test")).toBe("http://localhost:3000");
      expect(apiDocsBaseUrl("not a URL")).toBe("http://localhost:3000");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("documents the models catalog, benchmark and detail as aggregate-only research evidence", () => {
    const modelEndpoints = apiEndpoints.filter((endpoint) => endpoint.groupId === "models");
    expect(apiGroups.find((group) => group.id === "models")).toEqual({
      id: "models",
      eyebrow: "06 · Research",
      title: "Модели и доказательства",
      description: expect.stringContaining("research-only"),
    });
    expect(modelEndpoints.map(endpointOperation)).toEqual([
      "GET /api/models",
      "GET /api/models/benchmarks",
      "GET /api/models/{id}",
    ]);

    const expectedCommonErrors = [
      "401 UNAUTHORIZED",
      "503 MODEL_EVIDENCE_UNAVAILABLE",
      "503 WORKSPACE_UNAVAILABLE",
    ];
    for (const endpoint of modelEndpoints) {
      expect(endpoint.auth.kind).toBe("workspace");
      expect(endpoint.request.contentType).toBe("none");
      expect(endpoint.request.example).toBeNull();
      expect(endpoint.method).toBe("GET");
      expect(endpoint.notes?.join(" ")).toMatch(/research|runtime|null/iu);
      expect(codeExample(endpoint, "curl", "https://84.247.161.211"))
        .toContain('--cookie "./demeu-workspace.cookies"');
      expect(codeExample(endpoint, "curl", "https://84.247.161.211")).not.toContain("Content-Type");
      expect(codeExample(endpoint, "fetch")).toContain('credentials: "include"');
      expect(codeExample(endpoint, "fetch")).not.toContain("body: JSON.stringify");
      expect(endpoint.errors.map((item) => `${item.status} ${item.code}`).sort()).toEqual([
        ...expectedCommonErrors,
        ...(endpoint.id === "model-detail" ? ["404 NOT_FOUND"] : []),
      ].sort());
    }

    const list = modelEndpoints.find((endpoint) => endpoint.id === "models-list")!;
    const listExample = list.success.example as { schemaVersion: number; models: Record<string, unknown>[] };
    expect(Object.keys(listExample).sort()).toEqual(["models", "schemaVersion"]);
    expect(Object.keys(listExample.models[0]).sort()).toEqual([
      "availability", "baseline", "detailPath", "id", "kind", "limitations", "metricStatus",
      "primaryMetric", "researchOnly", "runtimeActivation", "taskId", "title",
    ].sort());
    expect(Object.keys(listExample.models[0].primaryMetric as object).sort()).toEqual([
      "denominator", "name", "numerator", "period", "reason", "rows", "state", "unit", "value",
    ].sort());

    const benchmark = modelEndpoints.find((endpoint) => endpoint.id === "models-benchmarks")!;
    const benchmarkExample = benchmark.success.example as { benchmark: Record<string, unknown> };
    expect(Object.keys(benchmarkExample.benchmark).sort()).toEqual([
      "candidates", "corpus", "evaluationDesign", "id", "limitations", "researchOnly",
      "runtimeIntegration", "title",
    ].sort());
    const candidate = (benchmarkExample.benchmark.candidates as Record<string, unknown>[])[0];
    expect(Object.keys(candidate).sort()).toEqual([
      "availability", "cost", "implementation", "itemCount", "latency", "metrics", "modelId", "slices",
      "structuredOutput", "unavailableReason",
    ].sort());
    expect(candidate).toMatchObject({
      modelId: "redflags-jev-1.13",
      implementation: { provider: "Convex", requestedModel: "typesafe/jev-1.13", observedModel: "typesafe/jev-1.13-20260917", threshold: 0.5, questionSpecId: "redflags-eight-trigger-v1" },
      availability: "measured",
      metrics: { tp: 79, fp: 0, tn: 80, fn: 1, precision: 1, recall: 0.9875, f1: 0.9937106918238994, falsePositiveRate: 0 },
      latency: { requestCount: 16, totalMs: 3042, meanMs: 190.125, p50Ms: 182, p95Ms: 260 },
      cost: { currency: "USD", amount: 0.001810746, coverage: 1, inputTokens: 43113, outputTokens: 3264 },
      structuredOutput: { logicalBatchCount: 16, acceptedRequestCount: 16, rejectedResponseCount: 0 },
      unavailableReason: null,
    });
    expect((candidate.slices as Record<string, unknown>)["language:ru"]).toEqual({ tp: 39, fp: 0, tn: 40, fn: 1, precision: 1, recall: 0.975, f1: 0.9873417721518987, falsePositiveRate: 0 });
    expect((candidate.slices as Record<string, unknown>)["language:kk"]).toEqual({ tp: 40, fp: 0, tn: 40, fn: 0, precision: 1, recall: 1, f1: 1, falsePositiveRate: 0 });
    expect((candidate.slices as Record<string, unknown>)["trigger:suicidal"]).toEqual({ tp: 10, fp: 0, tn: 10, fn: 0, precision: 1, recall: 1, f1: 1, falsePositiveRate: 0 });
    expect((candidate.slices as Record<string, unknown>)["trigger:consciousness"]).toEqual({ tp: 9, fp: 0, tn: 10, fn: 1, precision: 1, recall: 0.9, f1: 0.9473684210526316, falsePositiveRate: 0 });
    expect(benchmark.notes?.join(" ")).toMatch(/zero-shot|alpha|без seed|in-sample|batch/iu);
    const detail = modelEndpoints.find((endpoint) => endpoint.id === "model-detail")!;
    const detailExample = detail.success.example as { model: Record<string, unknown> };
    expect(Object.keys(detailExample.model).sort()).toEqual([
      "availability", "baseline", "configuration", "detailPath", "evaluation", "id", "kind",
      "limitations", "metricStatus", "primaryMetric", "researchOnly", "runtimeActivation",
      "source", "taskId", "title", "unavailable",
    ].sort());
    expect(detailExample.model).toMatchObject({
      id: "d2-laboratory-load-v0",
      availability: "unavailable",
      primaryMetric: { name: "mae", value: null, state: "unavailable" },
      baseline: null,
      unavailable: { code: "MISSING_LABORATORY_DEMAND_TARGET" },
    });
    expect(codeExample(detail, "curl", "https://84.247.161.211"))
      .toContain("https://84.247.161.211/api/models/triage-lr-v1");

    const serialized = JSON.stringify(modelEndpoints);
    for (const prohibited of ["weights", "feature_order", "class_order", "per_case", "internal_case_trace_do_not_show_before_judgment"])
      expect(serialized).not.toContain(prohibited);
  });

  it("documents the B1 examination requirements reference without overstating validation or validity", () => {
    const endpoint = apiEndpoints.find((candidate) => candidate.id === "examination-requirements-reference")!;
    expect(apiGroups.find((group) => group.id === "reference")).toEqual({
      id: "reference",
      eyebrow: "07 · Reference",
      title: "Справочник обследований",
      description: expect.stringContaining("B1"),
    });
    expect(endpointOperation(endpoint)).toBe("GET /api/reference/examination-requirements");
    expect(endpoint.groupId).toBe("reference");
    expect(endpoint.auth.kind).toBe("workspace");
    expect(endpoint.request).toMatchObject({ contentType: "none", fields: [], example: null });
    expect(endpoint.request.note).toContain("query");
    expect(endpoint.errors.map((item) => `${item.status} ${item.code}`).sort()).toEqual([
      "400 BAD_REQUEST",
      "401 UNAUTHORIZED",
      "405 METHOD_NOT_ALLOWED",
      "503 REFERENCE_CATALOGUE_UNAVAILABLE",
      "503 WORKSPACE_UNAVAILABLE",
    ].sort());

    const example = endpoint.success.example as {
      schemaVersion: number;
      catalogue: Record<string, unknown>;
      summary: Record<string, unknown>;
      profiles: { profile: string; requirements: Record<string, unknown>[] }[];
    };
    expect(Object.keys(example).sort()).toEqual(["catalogue", "profiles", "schemaVersion", "summary"]);
    expect(Object.keys(example.catalogue).sort()).toEqual([
      "id", "scope", "source", "status", "validated", "validationStatus", "version",
    ].sort());
    expect(example.catalogue).toMatchObject({
      id: "b1-examination-requirements-v1",
      version: "2025-02-17-order-9-appendix-5",
      status: "available",
      validated: false,
      validationStatus: "unvalidated",
    });
    expect(example.summary).toEqual({
      profileCount: 8,
      requirementOccurrenceCount: 148,
      uniqueRequirementCount: 57,
    });
    expect(Object.keys(example.profiles[0]).sort()).toEqual(["profile", "requirements"]);
    for (const requirement of example.profiles[0].requirements) {
      expect(Object.keys(requirement).sort()).toEqual(["conditional", "id", "label", "required", "validForDays"]);
    }
    expect(example.profiles[0].requirements.some((requirement) => requirement.validForDays === null)).toBe(true);
    expect(endpoint.notes?.join(" ")).toMatch(/no-store|validated=false|validForDays=null/iu);

    const curl = codeExample(endpoint, "curl", "https://84.247.161.211");
    expect(curl).toContain("GET");
    expect(curl).toContain("https://84.247.161.211/api/reference/examination-requirements");
    expect(curl).toContain('--cookie "./demeu-workspace.cookies"');
    expect(curl).not.toContain("Content-Type");
    const fetch = codeExample(endpoint, "fetch");
    expect(fetch).toContain('credentials: "include"');
    expect(fetch).not.toContain("body: JSON.stringify");

    const serialized = JSON.stringify(endpoint);
    expect(serialized).not.toMatch(/patientLabel|doctorToken|telegramChatId|passwordHash|organizationId/u);
    expect(serialized).not.toContain("/home/");
  });

  it("documents the complete live surface as a searchable, safe and keyboard-operable first-party reference", async () => {
    const documented = apiEndpoints.map(endpointOperation).sort();
    expect(documented).toEqual(implementedOperations());
    expect(new Set(documented).size).toBe(documented.length);
    expect(new Set(apiEndpoints.map((endpoint) => endpoint.id)).size).toBe(apiEndpoints.length);
    expect(new Set(apiEndpoints.map((endpoint) => endpoint.groupId))).toEqual(new Set(apiGroups.map((group) => group.id)));

    for (const endpoint of apiEndpoints) {
      expect(endpoint.summary.length).toBeGreaterThan(4);
      expect(endpoint.description.length).toBeGreaterThan(12);
      expect(endpoint.auth.label.length).toBeGreaterThan(3);
      expect(endpoint.auth.detail.length).toBeGreaterThan(12);
      expect(endpoint.success.status).toBeGreaterThanOrEqual(200);
      expect(endpoint.success.example).toBeTruthy();
      expect(endpoint.errors.length).toBeGreaterThan(0);
      expect(codeExample(endpoint, "curl")).toContain(endpoint.method);
      expect(codeExample(endpoint, "curl")).toContain(endpoint.path.split("{")[0]);
      expect(codeExample(endpoint, "fetch")).toContain("fetch(");
      expect(codeExample(endpoint, "fetch")).toContain("response.ok");
    }

    expect(flowStories).toHaveLength(3);
    expect(flowStories.flatMap((story) => story.steps).every((step) => apiEndpoints.some((endpoint) => endpoint.id === step.endpointId))).toBe(true);

    const errorPairs = (endpointId: string) => apiEndpoints
      .find((endpoint) => endpoint.id === endpointId)?.errors
      .map((item) => `${item.status} ${item.code}`)
      .sort();
    expect(errorPairs("chat-start")).toEqual([
      "400 BAD_REQUEST", "400 TOKEN_REQUIRED", "403 FORBIDDEN", "404 TOKEN_NOT_FOUND",
      "409 LINK_ALREADY_USED", "413 BODY_TOO_LARGE", "500 INTERNAL", "503 WORKSPACE_UNAVAILABLE",
    ].sort());
    expect(errorPairs("chat-turn")).toEqual([
      "400 BAD_REQUEST", "400 MESSAGE_REQUIRED", "400 SESSION_ID_REQUIRED", "401 UNAUTHORIZED",
      "403 FORBIDDEN", "404 SESSION_NOT_FOUND", "409 IDEMPOTENCY_CONFLICT", "409 SESSION_COMPLETED",
      "409 TURN_PENDING", "413 BODY_TOO_LARGE", "500 ANALYZE_FAILED", "500 INTERNAL",
      "500 LLM_UNAVAILABLE", "503 WORKSPACE_UNAVAILABLE",
    ].sort());
    expect(errorPairs("chat-finalize")).toEqual([
      "400 BAD_REQUEST", "400 SESSION_ID_REQUIRED", "401 UNAUTHORIZED", "403 FORBIDDEN",
      "404 SESSION_NOT_FOUND", "409 IDEMPOTENCY_CONFLICT", "409 SESSION_COMPLETED",
      "413 BODY_TOO_LARGE", "500 ANALYZE_FAILED", "500 INTERNAL", "503 WORKSPACE_UNAVAILABLE",
    ].sort());
    expect(errorPairs("chat-resume")).toEqual([
      "400 BAD_REQUEST", "401 UNAUTHORIZED", "403 FORBIDDEN", "404 NOT_FOUND",
      "404 SESSION_NOT_FOUND", "409 IDEMPOTENCY_CONFLICT", "413 BODY_TOO_LARGE",
      "500 INTERNAL", "503 WORKSPACE_UNAVAILABLE",
    ].sort());
    expect(errorPairs("create-link")).toEqual([
      "401 UNAUTHORIZED", "403 FORBIDDEN", "409 OWNER_CONFLICT", "429 RATE_LIMITED",
      "500 INTERNAL", "503 WORKSPACE_UNAVAILABLE",
    ].sort());
    expect(errorPairs("referrals-list")).toEqual([
      "400 BAD_REQUEST", "401 UNAUTHORIZED", "403 FORBIDDEN", "500 INTERNAL",
      "503 WORKSPACE_UNAVAILABLE",
    ].sort());
    const sharedReferralErrors = [
      "400 BAD_REQUEST", "401 UNAUTHORIZED", "403 FORBIDDEN", "404 NOT_FOUND",
      "409 IDEMPOTENCY_CONFLICT", "409 REVISION_CONFLICT", "413 BODY_TOO_LARGE", "500 INTERNAL",
      "503 WORKSPACE_UNAVAILABLE",
    ];
    expect(errorPairs("referral-create")).toEqual([
      ...sharedReferralErrors, "400 SOURCE_SESSION_REQUIRED", "409 SOURCE_SESSION_NOT_COMPLETED",
    ].sort());
    expect(errorPairs("referral-event")).toEqual([
      ...sharedReferralErrors, "400 ATTENDANCE_DATE_INVALID", "400 REASON_REQUIRED",
      "400 SOURCE_SESSION_REQUIRED", "409 NO_CHANGES", "409 REFERRAL_CANCELLED",
    ].sort());
    expect(errorPairs("referral-examination")).toEqual([
      ...sharedReferralErrors, "400 REASON_REQUIRED", "409 PACKAGE_CHANGED", "409 DUPLICATE_EXAMINATION",
    ].sort());
    for (const endpointId of ["chat-start", "chat-turn", "chat-finalize"]) {
      expect(errorPairs(endpointId)).not.toContain("429 RATE_LIMITED");
    }

    const healthError = apiEndpoints.find((endpoint) => endpoint.id === "health")?.errors[0];
    expect(healthError).toEqual({
      status: 404,
      meaning: expect.stringContaining("llm_ok=false"),
      response: {
        ok: true,
        commit: "a1b2c3d",
        model_version: "lr-v1",
        llm_ok: false,
        processing_mode: "external_llm",
      },
    });
    expect(healthError).not.toHaveProperty("code");

    const referralsList = apiEndpoints.find((endpoint) => endpoint.id === "referrals-list");
    expect(referralsList?.request.fields.map((item) => item.name)).toEqual(["state", "profile"]);
    expect(referralsList?.request.fields.find((item) => item.name === "state")?.description).toContain("not_attended");
    expect(referralsList?.request.fields.find((item) => item.name === "profile")?.description).toContain("пустой список");
    expect(referralsList?.request.note).toContain("не более одного раза");
    expect(referralsList?.request.note).toContain("400 BAD_REQUEST");
    expect(referralsList && codeExample(referralsList, "curl")).toContain("?state=preparing&profile=");
    const createLink = apiEndpoints.find((endpoint) => endpoint.id === "create-link");
    const productionOrigin = "https://84.247.161.211";
    for (const endpoint of apiEndpoints) {
      const curl = codeExample(endpoint, "curl", productionOrigin);
      expect(curl).not.toContain("demeu.example");
      if (endpoint.auth.kind === "workspace") {
        expect(curl).toContain('--cookie "./demeu-workspace.cookies"');
        if (endpoint.method !== "GET") expect(curl).toContain(`Origin: ${productionOrigin}`);
      }
    }
    const createLinkCurl = codeExample(createLink!, "curl", productionOrigin);
    expect(createLinkCurl).toContain('--cookie "./demeu-workspace.cookies"');
    expect(createLinkCurl).toContain(`Origin: ${productionOrigin}`);
    expect(createLinkCurl).toContain('x-doctor-code: <doctor-access-code>');
    expect(createLinkCurl).toContain(`${productionOrigin}/api/link`);
    expect(createLinkCurl).not.toContain("<workspace-session-cookie>");

    const loginCurl = codeExample(apiEndpoints.find((endpoint) => endpoint.id === "auth-login")!, "curl", productionOrigin);
    expect(loginCurl).toContain('--cookie-jar "./demeu-workspace.cookies"');
    expect(loginCurl).toContain(`Origin: ${productionOrigin}`);
    const authStateCurl = codeExample(apiEndpoints.find((endpoint) => endpoint.id === "auth-state")!, "curl", productionOrigin);
    expect(authStateCurl).toContain('--cookie "./demeu-workspace.cookies"');
    const chatStartCurl = codeExample(apiEndpoints.find((endpoint) => endpoint.id === "chat-start")!, "curl", productionOrigin);
    expect(chatStartCurl).toContain('--cookie-jar "./demeu-patient.cookies"');
    expect(chatStartCurl).toContain(`Origin: ${productionOrigin}`);
    const chatTurnCurl = codeExample(apiEndpoints.find((endpoint) => endpoint.id === "chat-turn")!, "curl", productionOrigin);
    expect(chatTurnCurl).toContain('--cookie "./demeu-patient.cookies"');
    expect(chatTurnCurl).toContain(`Origin: ${productionOrigin}`);
    expect(chatTurnCurl).not.toContain("<patient-capability-cookie>");
    const referralCreateCurl = codeExample(apiEndpoints.find((endpoint) => endpoint.id === "referral-create")!, "curl", productionOrigin);
    expect(referralCreateCurl).toContain('--cookie "./demeu-workspace.cookies"');
    expect(referralCreateCurl).toContain(`Origin: ${productionOrigin}`);

    const authStateExample = apiEndpoints.find((endpoint) => endpoint.id === "auth-state")?.success.example as {
      actor: Record<string, unknown>;
      enabled: boolean;
    };
    expect(Object.keys(authStateExample).sort()).toEqual(["actor", "enabled"]);
    expect(Object.keys(authStateExample.actor).sort()).toEqual([
      "access", "displayName", "id", "organizationDisplayName", "organizationId", "role",
    ]);
    expect(authStateExample.actor.access).toEqual(doctorAccessForTest);
    const authLoginExample = apiEndpoints.find((endpoint) => endpoint.id === "auth-login")?.success.example as {
      actor: Record<string, unknown>;
    };
    expect(authLoginExample.actor.access).toEqual(doctorAccessForTest);
    const aggregateExample = apiEndpoints.find((endpoint) => endpoint.id === "aggregates")?.success.example as Record<string, unknown>;
    expect(Object.keys(aggregateExample).sort()).toEqual(["access", "aggregates"]);
    expect(aggregateExample.access).toEqual({
      personalRecords: "none", aggregateRecords: "organization", aggregatePrivacy: "thresholded",
    });
    expect(apiEndpoints.find((endpoint) => endpoint.id === "chat-resume")?.request.fields.map((item) => item.name))
      .toEqual(["sessionId", "token", "requestId"]);

    const html = renderToStaticMarkup(<ApiDocsPortal baseUrl={productionOrigin} />);
    expect(html).toContain('type="search"');
    expect(html).toContain('aria-label="Навигация по API"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('id="language-tab-curl"');
    expect(html).toContain('aria-controls="language-examples-panel"');
    expect(html).toContain('id="language-examples-panel"');
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('aria-labelledby="language-tab-curl"');
    expect(html).toContain("Clinical flow stories");
    expect(html).toContain("Копировать");
    expect(html).toContain("Base URL");
    expect(html).toContain("JSON body");
    expect(html).toContain('&quot;llm_ok&quot;: false');
    expect((html.match(/data-api-endpoint="true"/gu) ?? [])).toHaveLength(apiEndpoints.length);
    for (const endpoint of apiEndpoints) expect(html).toContain(`id="${endpoint.id}"`);

    const ownedSource = [
      readFileSync("lib/api-catalog.ts", "utf8"),
      readFileSync("app/api-docs/portal.tsx", "utf8"),
      readFileSync("app/api-docs/page.tsx", "utf8"),
      readFileSync("app/api-docs.module.css", "utf8"),
    ].join("\n");
    expect(ownedSource).not.toMatch(/swagger-ui|redoc|openapi-react/iu);
    expect(ownedSource).not.toMatch(/sk-ant-|bot[0-9]{8,}:/iu);
    expect(readFileSync("app/api-docs.module.css", "utf8")).toMatch(/\.search:focus-within\s*\{/u);

    const reactTestEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => root.render(<ApiDocsPortal baseUrl={productionOrigin} />));

      const mobileLinks = Array.from(container.querySelectorAll<HTMLAnchorElement>("[data-mobile-endpoint-link]"));
      const accessibleNames = mobileLinks.map((link) => link.getAttribute("aria-label"));
      expect(mobileLinks).toHaveLength(apiEndpoints.length);
      expect(new Set(accessibleNames).size).toBe(apiEndpoints.length);
      expect(accessibleNames.every((name) => Boolean(name?.includes("/api/")) && !/^(GET|POST|DELETE)$/u.test(name ?? ""))).toBe(true);

      const curlTab = container.querySelector<HTMLButtonElement>("#language-tab-curl");
      const fetchTab = container.querySelector<HTMLButtonElement>("#language-tab-fetch");
      const panel = container.querySelector<HTMLElement>("#language-examples-panel");
      expect(curlTab?.getAttribute("aria-controls")).toBe("language-examples-panel");
      expect(fetchTab?.getAttribute("aria-controls")).toBe("language-examples-panel");
      expect(curlTab?.tabIndex).toBe(0);
      expect(fetchTab?.tabIndex).toBe(-1);
      expect(panel?.getAttribute("aria-labelledby")).toBe("language-tab-curl");

      curlTab?.focus();
      await act(async () => curlTab?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
      expect(document.activeElement).toBe(fetchTab);
      expect(fetchTab?.tabIndex).toBe(0);
      expect(curlTab?.tabIndex).toBe(-1);
      expect(panel?.getAttribute("aria-labelledby")).toBe("language-tab-fetch");

      await act(async () => fetchTab?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
      expect(document.activeElement).toBe(curlTab);
      await act(async () => curlTab?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
      expect(document.activeElement).toBe(fetchTab);
      await act(async () => fetchTab?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
      expect(document.activeElement).toBe(curlTab);
      await act(async () => curlTab?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
      expect(document.activeElement).toBe(fetchTab);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      delete reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT;
    }
  });
});
