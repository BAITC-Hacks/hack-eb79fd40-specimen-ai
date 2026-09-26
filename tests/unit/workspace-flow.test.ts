import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isOperationallyDelayed } from "../../app/workspace/operational-delay";
import { FileReferralRepository, MemoryReferralRepository, ReferralService } from "../../lib/referrals/service";
import type { ReferralActor, RequirementCatalogue } from "../../lib/referrals/types";
import { MemorySessionStore } from "../../lib/store";
import type { TriageResult } from "../../lib/types";
import { handleReferral, handleReferrals, type WorkspaceApiDeps } from "../../lib/workspace-api";

const DAY = 86_400_000;
const BASE = "https://workspace.example.test";
const START = Date.parse("2026-09-20T12:00:00Z");
const doctor: ReferralActor = { id: "doctor-a", displayName: "Врач А", role: "doctor", organizationId: "org-a" };
const other: ReferralActor = { ...doctor, id: "doctor-b" };
const owner: ReferralActor = { ...doctor, id: "owner-a", role: "owner" };
const catalogue: RequirementCatalogue = {
  schemaVersion: 1,
  version: "flow-test",
  status: "available",
  source: "synthetic-flow-test",
  validated: true,
  scope: { population: "adult", careSetting: "inpatient", treatment: "operative" },
  profiles: [
    { profile: "Хирургический", requirements: [{ id: "core", label: "Основное обследование", required: true, conditional: false, validForDays: 30 }] },
    { profile: "Урологический", requirements: [{ id: "uro", label: "Профильное обследование", required: true, conditional: false, validForDays: 30 }] },
  ],
};
const triage: TriageResult = {
  anamnesis: { chief_complaint: "Тестовая жалоба", symptom: { onset: "", location: "", quality: "", severity: null, modifiers: "", associated: [] }, past_history: [], chronic: [], allergies: [], medications: [], context: { age: null, sex: "unknown", pregnancy: "na", risk_factors: [] } },
  red_flags: [], urgency: "planned", urgency_reasons: [], routing: [],
  hypothesis: { text: "Предварительная гипотеза не сформирована", confidence: 0, disclaimer: "Это не диагноз, решает врач" },
  source: "rules_only",
};

function request(path: string): Request {
  return new Request(`${BASE}${path}`, { headers: { origin: BASE } });
}

describe("D6a patient and referral journey", () => {
  it("persists explicit sent confirmation independently of unvalidated completeness", async () => {
    let now = START;
    const service = new ReferralService(new MemoryReferralRepository(), {
      now: () => now,
      catalogue: { ...catalogue, validated: false },
    });
    const created = await service.create(doctor, {
      patientLabel: "Непроверенный пакет",
      profile: "Хирургический",
      idempotencyKey: "unvalidated-create",
    });
    expect(created).toMatchObject({ flow: "preparing", completeness: { status: "unknown", catalogueAvailable: false } });

    now += 2 * DAY;
    const enteredAt = START + DAY;
    const sent = await service.update(doctor, created.id, {
      expectedRevision: created.revision,
      idempotencyKey: "unvalidated-sent",
      patch: { sent: true },
      occurredAt: enteredAt,
    });
    expect(sent).toMatchObject({ sent: true, flow: "sent", observedStageDays: 1,
      completeness: { status: "unknown", catalogueAvailable: false } });
    expect(sent.events.at(-1)?.transition).toMatchObject({ from: "preparing", to: "sent", enteredAt });
    expect((await service.list(doctor, { state: "sent" })).map((entry) => entry.id)).toEqual([sent.id]);
    expect(await service.list(doctor, { state: "preparing" })).toEqual([]);
  });

  it("requires an explicit reasoned reopen before a cancelled referral can progress", async () => {
    const service = new ReferralService(new MemoryReferralRepository(), { now: () => START, catalogue });
    const created = await service.create(doctor, {
      patientLabel: "Отменённый эпизод",
      profile: "Хирургический",
      idempotencyKey: "cancel-create",
    });
    const cancelled = await service.update(doctor, created.id, {
      expectedRevision: created.revision,
      idempotencyKey: "cancel",
      patch: { cancelled: true },
      reason: "Пациент временно отказался",
    });
    await expect(service.update(doctor, cancelled.id, {
      expectedRevision: cancelled.revision,
      idempotencyKey: "cancelled-progress",
      patch: { scheduledDate: "2026-09-20", attendance: "attended" },
    })).rejects.toMatchObject({ code: "REFERRAL_CANCELLED", status: 409 });
    expect(await service.detail(doctor, cancelled.id)).toMatchObject({ revision: cancelled.revision, cancelled: true, attendance: null });

    await expect(service.update(doctor, cancelled.id, {
      expectedRevision: cancelled.revision,
      idempotencyKey: "reopen-without-reason",
      patch: { cancelled: false },
    })).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    const reopened = await service.update(doctor, cancelled.id, {
      expectedRevision: cancelled.revision,
      idempotencyKey: "reasoned-reopen",
      patch: { cancelled: false, scheduledDate: "2026-09-20", attendance: "attended" },
      reason: "Пациент подтвердил продолжение госпитализации",
    });
    expect(reopened).toMatchObject({ cancelled: false, attendance: "attended", flow: "attended" });
    expect(reopened.events.at(-1)?.reason).toBe("Пациент подтвердил продолжение госпитализации");
  });

  it("covers seven phases, both arrival outcomes, legal corrections and source de-duplication", async () => {
    let serial = 0;
    const service = new ReferralService(new MemoryReferralRepository(), { now: () => START, id: () => `flow-${++serial}`, catalogue });
    await service.bindLink("patient-link", doctor);
    const source = { sessionId: "intake-1", doctorToken: "patient-link", result: triage };
    const input = { patientLabel: "Эпизод", profile: "Хирургический", sourceSessionId: source.sessionId, idempotencyKey: "create-1" };
    let referral = await service.create(doctor, input, source);
    expect(referral.flow).toBe("interviewed");
    expect((await service.create(owner, { ...input, patientLabel: "Дубликат", idempotencyKey: "create-2" }, source)).id).toBe(referral.id);
    expect(await service.list(owner)).toHaveLength(1);

    referral = await service.update(doctor, referral.id, { expectedRevision: referral.revision, idempotencyKey: "specialist", patch: { specialistReferred: true } });
    expect(referral.flow).toBe("specialist_referred");
    referral = await service.update(doctor, referral.id, { expectedRevision: referral.revision, idempotencyKey: "prepare", patch: { preparationStarted: true } });
    expect(referral.flow).toBe("preparing");
    referral = await service.examination(doctor, referral.id, { expectedRevision: referral.revision, idempotencyKey: "exam", record: {
      requirementId: "core", label: "Основное обследование", resultAvailable: true,
      performedOn: "2026-09-20", expiresOn: "2026-10-20", applicability: "yes",
    } });
    expect(referral.flow).toBe("preparing");
    referral = await service.update(doctor, referral.id, { expectedRevision: referral.revision, idempotencyKey: "sent", patch: { sent: true } });
    expect(referral.flow).toBe("sent");
    referral = await service.update(doctor, referral.id, { expectedRevision: referral.revision, idempotencyKey: "waiting", patch: { queue: true } });
    expect(referral.flow).toBe("waiting");
    referral = await service.update(doctor, referral.id, { expectedRevision: referral.revision, idempotencyKey: "scheduled", patch: { scheduledDate: "2026-09-20" } });
    expect(referral.flow).toBe("scheduled");
    referral = await service.update(doctor, referral.id, { expectedRevision: referral.revision, idempotencyKey: "attended", patch: { attendance: "attended" } });
    expect(referral.flow).toBe("attended");
    await expect(service.update(doctor, referral.id, { expectedRevision: referral.revision, idempotencyKey: "outcome-without-reason", patch: { attendance: "not_attended" } }))
      .rejects.toMatchObject({ code: "REASON_REQUIRED" });
    referral = await service.update(doctor, referral.id, { expectedRevision: referral.revision, idempotencyKey: "no-show", patch: { attendance: "not_attended" }, reason: "Исправлен исход явки" });
    expect(referral.flow).toBe("not_attended");
    referral = await service.update(doctor, referral.id, { expectedRevision: referral.revision, idempotencyKey: "cancelled", patch: { cancelled: true }, reason: "Отмена подтверждена отдельно" });
    expect(referral.flow).toBe("not_attended");

    expect(referral.events.flatMap((event) => event.transition ? [event.transition.to] : [])).toEqual([
      "interviewed", "specialist_referred", "preparing", "sent", "waiting", "scheduled", "attended", "not_attended",
    ]);
  });

  it("filters scoped lists by journey state and exact profile, including both arrival outcomes", async () => {
    const service = new ReferralService(new MemoryReferralRepository(), { now: () => START, catalogue });
    const surgical = await service.create(doctor, { patientLabel: "Хирургия", profile: "Хирургический", idempotencyKey: "surgical" });
    const urology = await service.create(doctor, { patientLabel: "Урология", profile: "Урологический", idempotencyKey: "urology" });
    const hidden = await service.create(other, { patientLabel: "Чужая запись", profile: "Урологический", idempotencyKey: "hidden" });
    await service.update(doctor, surgical.id, { expectedRevision: 1, idempotencyKey: "surgical-date", patch: { scheduledDate: "2026-09-20", attendance: "attended" } });
    await service.update(doctor, urology.id, { expectedRevision: 1, idempotencyKey: "urology-date", patch: { scheduledDate: "2026-09-20", attendance: "not_attended" } });
    await service.update(other, hidden.id, { expectedRevision: 1, idempotencyKey: "hidden-date", patch: { scheduledDate: "2026-09-20", attendance: "not_attended" } });
    const deps: WorkspaceApiDeps = { actor: async () => doctor, referrals: service };

    const attended = await (await handleReferrals(request("/api/referrals?state=attended&profile=Хирургический"), deps)).json();
    expect(attended.referrals.map((entry: { patientLabel: string }) => entry.patientLabel)).toEqual(["Хирургия"]);
    const noShow = await (await handleReferrals(request("/api/referrals?state=not_attended&profile=Урологический"), deps)).json();
    expect(noShow.referrals.map((entry: { patientLabel: string }) => entry.patientLabel)).toEqual(["Урология"]);
    expect((await handleReferrals(request("/api/referrals?state=ready"), deps)).status).toBe(400);
    expect((await handleReferrals(request("/api/referrals?doctorId=doctor-b"), deps)).status).toBe(400);
  });

  it("joins the scoped intake, anamnesis, package, date and history in one card DTO", async () => {
    const service = new ReferralService(new MemoryReferralRepository(), { now: () => START, catalogue });
    const sessions = new MemorySessionStore();
    const token = await sessions.createDoctorToken();
    await service.bindLink(token, doctor);
    const intake = await sessions.createSession(token);
    await sessions.appendMessage(intake.id, { role: "user", content: "Закрытый текст разговора" });
    await sessions.completeSession(intake.id, triage);
    const referral = await service.create(doctor, {
      patientLabel: "Связанный эпизод", profile: "Хирургический", sourceSessionId: intake.id, idempotencyKey: "linked",
    }, { sessionId: intake.id, doctorToken: token, result: triage });
    const deps: WorkspaceApiDeps = { actor: async () => doctor, referrals: service, sessions };
    const response = await handleReferral(request(`/api/referrals/${referral.id}`), referral.id, deps);
    const card = (await response.json()).referral;

    expect(card).toMatchObject({
      id: referral.id,
      intake: { sessionId: intake.id, status: "completed", deliveryStatus: "pending" },
      triageSnapshot: { anamnesis: { chief_complaint: "Тестовая жалоба" } },
      completeness: { catalogueVersion: "flow-test" },
      scheduledDate: null,
      events: [{ type: "created", transition: { from: null, to: "interviewed" } }],
    });
    expect(JSON.stringify(card)).not.toContain("Закрытый текст разговора");
    expect((await handleReferral(request(`/api/referrals/${referral.id}`), referral.id, { ...deps, actor: async () => other })).status).toBe(404);
  });

  it("derives transition time, counters and mean stage duration from the v2 journal after repository reload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "demeu-workspace-flow-"));
    const filename = join(directory, "referrals.json");
    let now = START;
    let repository = new FileReferralRepository(filename);
    try {
      let service = new ReferralService(repository, { now: () => now, catalogue });
      const referral = await service.create(doctor, { patientLabel: "Длительный этап", profile: "Хирургический", idempotencyKey: "duration" });
      now += 2 * DAY;
      const enteredAt = START + DAY;
      const waiting = await service.update(doctor, referral.id, {
        expectedRevision: 1, idempotencyKey: "waiting", patch: { queue: true }, occurredAt: enteredAt,
      });
      expect(waiting.events.at(-1)?.transition).toMatchObject({ from: "preparing", to: "waiting", enteredAt });
      await repository.close();

      const raw = await readFile(filename, "utf8");
      const persisted = JSON.parse(raw) as { schemaVersion: number; referrals: { events: Record<string, unknown>[] }[] };
      expect(persisted.schemaVersion).toBe(2);
      expect(raw).not.toContain('"transition"');
      expect(persisted.referrals[0].events.map((event) => Object.keys(event).sort())).toEqual([
        ["actorId", "actorName", "after", "before", "id", "occurredAt", "reason", "recordedAt", "revision", "source", "type"].sort(),
        ["actorId", "actorName", "after", "before", "id", "occurredAt", "reason", "recordedAt", "revision", "source", "type"].sort(),
      ]);

      now += 2 * DAY;
      repository = new FileReferralRepository(filename);
      service = new ReferralService(repository, { now: () => now, catalogue });
      const restored = await service.detail(doctor, referral.id);
      expect(restored).toMatchObject({ flow: "waiting", observedStageDays: 3 });
      expect(restored.events.at(-1)?.transition).toMatchObject({ from: "preparing", to: "waiting", enteredAt });
      expect(isOperationallyDelayed(restored, "2")).toBe(true);
      expect(await service.aggregates(doctor)).toMatchObject({
        total: 1,
        groups: [{ flow: "waiting", count: 1, meanObservedDays: 3, observedTimeCount: 1 }],
      });

      const operationalSource = await readFile(join(process.cwd(), "app/workspace/operational-delay.ts"), "utf8");
      expect(operationalSource).toContain("window.localStorage.getItem(key)");
      expect(operationalSource).toContain("window.localStorage.setItem(key, value)");
      expect(operationalSource).toContain("organizationId");
      expect(operationalSource).toContain("actorId");
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
