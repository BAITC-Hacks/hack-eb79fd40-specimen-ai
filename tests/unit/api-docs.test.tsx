// @vitest-environment jsdom

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiDocsPortal } from "../../app/api-docs/portal";
import { apiEndpoints, apiGroups, codeExample, endpointOperation, flowStories } from "../../lib/api-catalog";

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
    for (const match of source.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|DELETE)\b|export\s+const\s+(GET|POST|DELETE)\s*=/gu)) {
      methods.add(match[1] ?? match[2]);
    }
    for (const method of methods) operations.push(`${method} ${route}`);
  }
  return operations.sort();
}

describe("Demeu API portal", () => {
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
    expect(errorPairs("referral-create")).toContain("400 SOURCE_SESSION_REQUIRED");
    expect(errorPairs("referral-event")).toEqual(expect.arrayContaining([
      "400 ATTENDANCE_DATE_INVALID", "400 SOURCE_SESSION_REQUIRED", "409 REFERRAL_CANCELLED",
    ]));
    expect(errorPairs("referral-examination")).toContain("409 DUPLICATE_EXAMINATION");
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
    expect(createLink && codeExample(createLink, "curl", "https://84.247.161.211"))
      .toContain('--cookie "<workspace-session-cookie>"');
    expect(createLink && codeExample(createLink, "curl", "https://84.247.161.211"))
      .toContain("https://84.247.161.211/api/link");
    expect(codeExample(apiEndpoints.find((endpoint) => endpoint.id === "chat-start")!, "curl", "https://84.247.161.211"))
      .toContain('Origin: https://84.247.161.211');
    expect(apiEndpoints.find((endpoint) => endpoint.id === "auth-state")?.success.example)
      .toMatchObject({ actor: { access: doctorAccessForTest } });
    expect(apiEndpoints.find((endpoint) => endpoint.id === "aggregates")?.success.example)
      .toMatchObject({ access: { personalRecords: "none", aggregatePrivacy: "thresholded" } });
    expect(apiEndpoints.find((endpoint) => endpoint.id === "chat-resume")?.request.fields.map((item) => item.name))
      .toEqual(["sessionId", "token", "requestId"]);

    const html = renderToStaticMarkup(<ApiDocsPortal />);
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
      await act(async () => root.render(<ApiDocsPortal />));

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
