import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleFinalize } from "../../app/api/chat/finalize/handler";
import { patientSafeResumeResponse } from "../../lib/patient-response";
import PatientLayout from "../../app/c/[token]/layout";
import { MemorySessionStore } from "../../lib/store";
import type { TriageResult } from "../../lib/types";
import {
  handleWorkspaceIntake,
  type WorkspaceApiDeps,
} from "../../lib/workspace-api";
import {
  WorkspaceAuthError,
  type WorkspaceActor,
} from "../../lib/workspace-auth";

const RESULT: TriageResult = {
  anamnesis: {
    chief_complaint: "вымышленная жалоба",
    symptom: {
      onset: "сегодня",
      location: "",
      quality: "",
      severity: null,
      modifiers: "",
      associated: [],
    },
    past_history: [],
    chronic: [],
    allergies: [],
    medications: [],
    context: {
      age: null,
      sex: "unknown",
      pregnancy: "na",
      risk_factors: [],
    },
  },
  red_flags: [],
  urgency: "planned",
  urgency_reasons: ["Тестовый результат"],
  routing: [{ specialty: "терапия", confidence: 1 }],
  hypothesis: {
    text: "Тестовая предварительная гипотеза.",
    confidence: 0,
    disclaimer: "Это не диагноз. Финальное решение принимает врач.",
  },
  source: "rules_only",
};

function finalizeRequest(sessionId: string): NextRequest {
  return new NextRequest("http://localhost/api/chat/finalize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
}

async function completedSession() {
  const sessions = new MemorySessionStore();
  const token = await sessions.createDoctorToken();
  const session = await sessions.createSession(token);
  await sessions.appendMessage(session.id, {
    role: "user",
    content: "Вымышленный ответ пациента",
  });
  return { sessions, session, token };
}

describe("patient API privacy boundary", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns only a minimal closing from the patient finalize endpoint", async () => {
    const { sessions, session } = await completedSession();
    const response = await handleFinalize(finalizeRequest(session.id), {
      sessionStore: sessions,
      analyze: async () => RESULT,
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      closing: {
        emergency: false,
        text: "Спасибо. Ваши ответы переданы врачу. Дальнейшие шаги врач обсудит с вами отдельно.",
      },
      replayed: false,
    });
    expect(JSON.stringify(payload)).not.toContain("hypothesis");
    expect(payload).not.toHaveProperty("result");
    expect(payload).not.toHaveProperty("source");
  });

  it("strips a stored clinical result from the patient resume envelope", async () => {
    const raw = Response.json({
      sessionId: "session",
      language: "ru",
      messages: [],
      turnsLeft: 0,
      status: "completed",
      result: RESULT,
    });
    const response = await patientSafeResumeResponse(raw);
    const payload = await response.json();

    expect(payload).toMatchObject({
      status: "completed",
      closing: { emergency: false },
    });
    expect(payload).not.toHaveProperty("result");
    expect(JSON.stringify(payload)).not.toContain("hypothesis");
  });

  it("keeps the full result behind the scoped doctor endpoint", async () => {
    const { sessions, session, token } = await completedSession();
    await sessions.completeSession(session.id, RESULT);
    const doctor: WorkspaceActor = {
      id: "doctor-one",
      displayName: "Врач",
      role: "doctor",
      organizationId: "test-neuro",
    };
    const referrals = {
      ownerForToken: async (candidate: string) => candidate === token ? doctor : null,
      list: async () => [],
    } as unknown as NonNullable<WorkspaceApiDeps["referrals"]>;
    const response = await handleWorkspaceIntake(
      new Request(`https://example.test/api/workspace/intakes/${session.id}`),
      session.id,
      {
        actor: async () => doctor,
        sessions,
        referrals,
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      intake: { sessionId: session.id, result: RESULT },
    });

    const unauthorized = await handleWorkspaceIntake(
      new Request(`https://example.test/api/workspace/intakes/${session.id}`),
      session.id,
      {
        actor: async () => { throw new WorkspaceAuthError(401, "UNAUTHORIZED"); },
        sessions,
        referrals,
      },
    );
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).not.toHaveProperty("intake");
  });

  it("allows ?demo=1 only behind a non-production server gate and uses static synthetic data", () => {
    const page = readFileSync(
      new URL("../../app/c/[token]/page.tsx", import.meta.url),
      "utf8",
    );

    vi.stubEnv("DEMEU_LOCAL_DEMO", "1");
    vi.stubEnv("NODE_ENV", "production");
    expect(renderToStaticMarkup(createElement(PatientLayout, null, "patient")))
      .not.toContain("data-demeu-local-demo");

    vi.stubEnv("NODE_ENV", "development");
    expect(renderToStaticMarkup(createElement(PatientLayout, null, "patient")))
      .toContain('data-demeu-local-demo="synthetic"');
    expect(page).toContain("localDemo && query.get(\"demo\") === \"1\"");
    expect(page).toContain("<DoctorPanel result={SYNTHETIC_DEMO_RESULT}");
    expect(page).not.toContain("<DoctorPanel result={result}");
  });
});
