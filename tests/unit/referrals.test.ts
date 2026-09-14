import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileReferralRepository, MemoryReferralRepository, ReferralService, validateReferralDatabase } from "../../lib/referrals/service";
import { evaluateCompleteness, isCalendarDate, localDate, validateRequirementCatalogue } from "../../lib/referrals/requirements";
import type { ExaminationRecord, ReferralActor, ReferralDatabase, RequirementCatalogue } from "../../lib/referrals/types";
import type { TriageResult } from "../../lib/types";

const doctor: ReferralActor = { id: "doctor-a", displayName: "Врач А", role: "doctor", organizationId: "org-a" };
const colleague: ReferralActor = { ...doctor, id: "doctor-b" };
const owner: ReferralActor = { ...doctor, id: "owner", role: "owner" };
const analyst: ReferralActor = { ...doctor, id: "analyst", role: "analyst" };
const now = Date.parse("2026-09-13T12:00:00Z");
const triage: TriageResult = {
  anamnesis: { chief_complaint: "Пример", symptom: { onset: "", location: "", quality: "", severity: null, modifiers: "", associated: [] }, past_history: [], chronic: [], allergies: [], medications: [], context: { age: null, sex: "unknown", pregnancy: "na", risk_factors: [] } },
  red_flags: [], urgency: "planned", urgency_reasons: [], routing: [], hypothesis: { text: "Пример для врача", confidence: 0, disclaimer: "Это не диагноз, решает врач" }, source: "rules_only",
};
const catalogue: RequirementCatalogue = { schemaVersion: 1, version: "test-only", status: "available", source: "synthetic-test-fixture", validated: true,
  profiles: [{ profile: "тестовый", requirements: [{ id: "r1", label: "Тестовое обследование", required: true, conditional: false, validForDays: null }] }] };
const exam: ExaminationRecord = { id: "exam", requirementId: "r1", label: "Тестовое обследование", resultAvailable: true, performedOn: "2026-09-10", expiresOn: "2026-09-20", applicability: "yes" };
const createInput = (key = "create") => ({ patientLabel: "Эпизод 1", profile: "тестовый", idempotencyKey: key });
function setup() {
  const repository = new MemoryReferralRepository();
  let clock = now;
  let serial = 0;
  const service = new ReferralService(repository, { now: () => clock, id: () => `id-${++serial}` });
  return { repository, service, advance: (days: number) => { clock += days * 86400000; } };
}

describe("направления: принадлежность и подтверждения", () => {
  it("фиксирует одну отметку записи при движущихся часах", async () => {
    let clock = now;
    const service = new ReferralService(new MemoryReferralRepository(), { now: () => clock++ });
    const created = await service.create(doctor, createInput());
    expect(created.createdAt).toBe(created.updatedAt);
    expect(created.createdAt).toBe(created.events[0].recordedAt);
    const updated = await service.update(doctor, created.id, { expectedRevision: 1, idempotencyKey: "queue", patch: { queue: true } });
    expect(updated.updatedAt).toBe(updated.events[1].recordedAt);
    const { id: _id, ...record } = exam;
    void _id;
    const examined = await service.examination(doctor, created.id, { expectedRevision: 2, idempotencyKey: "exam", record });
    expect(examined.updatedAt).toBe(examined.events[2].recordedAt);
  });
  it("неизвестные сведения остаются null, срок сам не устанавливает явку", async () => {
    const { service, advance } = setup();
    const r = await service.create(doctor, createInput());
    expect(r).toMatchObject({ queue: null, sent: null, attendance: null, scheduledDate: null, flow: "preparing" });
    const scheduled = await service.update(doctor, r.id, { expectedRevision: 1, idempotencyKey: "date", patch: { scheduledDate: "2026-09-14" } });
    expect(scheduled).toMatchObject({ queue: null, sent: null, flow: "scheduled" });
    advance(7);
    expect(await service.detail(doctor, r.id)).toMatchObject({ attendance: null, flow: "scheduled" });
  });
  it("не присваивает чужие/непривязанные опросы и сохраняет ранние этапы", async () => {
    const { service } = setup();
    const source = { sessionId: "s1", doctorToken: "t1", result: triage };
    const input = { ...createInput(), sourceSessionId: "s1" };
    await expect(service.create(doctor, input, source)).rejects.toMatchObject({ status: 404 });
    await service.bindLink("t1", doctor);
    await expect(service.create(colleague, input, source)).rejects.toMatchObject({ status: 404 });
    await expect(service.create(doctor, input)).rejects.toMatchObject({ code: "SOURCE_SESSION_REQUIRED" });
    const r = await service.create(doctor, input, source);
    expect((await service.replayCreate(doctor, input))?.id).toBe(r.id);
    expect(await service.replayCreate(doctor, { ...input, idempotencyKey: "new-key" })).toBeNull();
    await expect(service.replayCreate(doctor, { ...input, patientLabel: "changed" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(r).toMatchObject({ flow: "interviewed", preparationStarted: false, doctorId: doctor.id });
    expect(r.triageSnapshot).toEqual(triage);
    expect(r.triageSnapshot).not.toHaveProperty("messages");
    const referred = await service.update(doctor, r.id, { expectedRevision: 1, idempotencyKey: "specialist", patch: { specialistReferred: true } });
    expect(referred.flow).toBe("specialist_referred");
    const preparing = await service.update(doctor, r.id, { expectedRevision: 2, idempotencyKey: "prepare", patch: { preparationStarted: true } });
    expect(preparing.flow).toBe("preparing");
    const owned = await service.create(owner, { ...input, idempotencyKey: "owner-create" }, source);
    expect(owned.doctorId).toBe(doctor.id);
    await expect(service.bindLink("t1", colleague)).rejects.toMatchObject({ status: 409 });
  });
  it("не отдаёт чужие карточки, списки и памятки", async () => {
    const { service } = setup();
    const r = await service.create(doctor, createInput());
    expect(await service.list(colleague)).toEqual([]);
    await expect(service.detail(colleague, r.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.detail(colleague, "missing")).rejects.toMatchObject({ status: 404 });
    await expect(service.memo(analyst, r.id)).rejects.toMatchObject({ status: 403 });
    await expect(service.detail({ ...owner, organizationId: "other" }, r.id)).rejects.toMatchObject({ status: 404 });
    expect((await service.list(owner)).map((entry) => entry.id)).toEqual([r.id]);
  });
  it("не допускает клиентские поля принадлежности и непредусмотренный payload", async () => {
    const { service } = setup();
    await expect(service.create(doctor, { ...createInput(), doctorId: "other" } as never)).rejects.toMatchObject({ status: 400 });
    const r = await service.create(doctor, createInput());
    await expect(service.update(doctor, r.id, { expectedRevision: 1, idempotencyKey: "x", patch: { queue: true }, transcript: "secret" } as never)).rejects.toMatchObject({ status: 400 });
    await expect(service.examination(doctor, r.id, { expectedRevision: 1, idempotencyKey: "y", record: { ...exam, transcript: "secret" } } as never)).rejects.toMatchObject({ status: 400 });
  });
  it("повтор команды идемпотентен, другой payload и устаревшая ревизия отвергаются", async () => {
    const { service } = setup();
    const r = await service.create(doctor, createInput());
    expect((await service.create(doctor, createInput())).id).toBe(r.id);
    const command = { expectedRevision: 1, idempotencyKey: "queue", patch: { queue: true }, occurredAt: now - 1000 };
    const first = await service.update(doctor, r.id, command);
    expect(await service.update(doctor, r.id, command)).toEqual(first);
    await expect(service.update(doctor, r.id, { ...command, patch: { queue: false } })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(service.update(doctor, r.id, { ...command, idempotencyKey: "stale" })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(first.events[1]).toMatchObject({ actorId: doctor.id, recordedAt: now, occurredAt: now - 1000, source: "doctor_confirmation", before: { queue: null }, after: { queue: true } });
  });
  it("коррекция и отмена требуют причину, история не переписывается", async () => {
    const { service } = setup();
    const r = await service.create(doctor, createInput());
    const first = await service.update(doctor, r.id, { expectedRevision: 1, idempotencyKey: "queue", patch: { queue: true } });
    await expect(service.update(doctor, r.id, { expectedRevision: 2, idempotencyKey: "clear", patch: { queue: null } })).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    const next = await service.update(doctor, r.id, { expectedRevision: 2, idempotencyKey: "clear", patch: { queue: null }, reason: "Исправлена запись" });
    expect(next.events[1]).toEqual(first.events[1]);
    expect(next.events[2]).toMatchObject({ before: { queue: true }, after: { queue: null }, reason: "Исправлена запись" });
    await expect(service.update(doctor, r.id, { expectedRevision: 3, idempotencyKey: "cancel", patch: { cancelled: true } })).rejects.toMatchObject({ code: "REASON_REQUIRED" });
  });
  it("отмена подготовки без исходного опроса не создаёт вымышленный этап опроса", async () => {
    const { service } = setup();
    const r = await service.create(doctor, createInput());
    await expect(service.update(doctor, r.id, { expectedRevision: 1, idempotencyKey: "rollback", patch: { preparationStarted: false }, reason: "Исправление" })).rejects.toMatchObject({ code: "SOURCE_SESSION_REQUIRED" });
    expect((await service.detail(doctor, r.id)).flow).toBe("preparing");
    const confirmed = await service.update(doctor, r.id, { expectedRevision: 1, idempotencyKey: "specialist", patch: { preparationStarted: false, specialistReferred: true }, reason: "Подтверждён маршрут" });
    expect(confirmed.flow).toBe("specialist_referred");
  });
  it("параллельные изменения одной ревизии не затирают друг друга", async () => {
    const { service } = setup();
    const r = await service.create(doctor, createInput());
    const results = await Promise.allSettled(["a", "b"].map((idempotencyKey) => service.update(doctor, r.id, { expectedRevision: 1, idempotencyKey, patch: { queue: true } })));
    expect(results.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect((await service.detail(doctor, r.id)).events).toHaveLength(2);
  });
  it.each(["2026-02-30", "2026-13-01", "2026-9-01", "not-a-date"])("отвергает неверную дату %s", async (scheduledDate) => {
    const { service } = setup();
    const r = await service.create(doctor, createInput());
    await expect(service.update(doctor, r.id, { expectedRevision: 1, idempotencyKey: "date", patch: { scheduledDate } })).rejects.toMatchObject({ status: 400 });
  });
  it("не принимает фактическое событие из будущего и не меняет ревизию при отказе", async () => {
    const { service } = setup();
    const r = await service.create(doctor, createInput());
    await expect(service.update(doctor, r.id, { expectedRevision: 1, idempotencyKey: "future", patch: { queue: true }, occurredAt: now + 1 })).rejects.toMatchObject({ status: 400 });
    expect((await service.detail(doctor, r.id)).revision).toBe(1);
  });
  it("памятка содержит только разрешённые поля и неизвестные данные не маскирует", async () => {
    const { service } = setup();
    const r = await service.create(doctor, createInput());
    const { id: _id, ...record } = exam;
    void _id;
    const added = await service.examination(doctor, r.id, { expectedRevision: 1, idempotencyKey: "exam", record });
    expect(added.completeness.status).toBe("unknown");
    const memo = await service.memo(doctor, r.id);
    expect(Object.keys(memo).sort()).toEqual(["catalogueAvailable", "destinationOrganization", "items", "patientLabel", "scheduledDate"]);
    expect(memo).toMatchObject({ scheduledDate: null, catalogueAvailable: false, items: [{ label: record.label, status: "unknown", expiresOn: "2026-09-20" }] });
  });
});

describe("комплектность: тестовый, не нормативный справочник", () => {
  const evaluate = (records: ExaminationRecord[], changed: Partial<RequirementCatalogue> = {}) => evaluateCompleteness({ profile: "тестовый", scheduledDate: "2026-09-20", examinations: records }, { ...catalogue, ...changed }, now);
  it("не называет пустой/неподтверждённый справочник полным", () => {
    expect(evaluate([exam], { validated: false }).status).toBe("unknown");
    expect(evaluate([exam], { profiles: [] }).status).toBe("unknown");
    expect(evaluate([exam], { status: "unavailable" }).status).toBe("unknown");
    expect(evaluate([exam], { source: null }).status).toBe("unknown");
  });
  it("отвергает повреждённый срок и дубли справочника", () => {
    const bad = structuredClone(catalogue);
    bad.profiles[0].requirements[0].validForDays = -1;
    expect(() => validateRequirementCatalogue(bad)).toThrow("Invalid examination requirement catalogue");
    bad.profiles[0].requirements[0].validForDays = null;
    bad.profiles[0].requirements.push(bad.profiles[0].requirements[0]);
    expect(() => validateRequirementCatalogue(bad)).toThrow("Invalid examination requirement catalogue");
  });
  it("различает наличие, неизвестность, отсутствие и просрочку результата", () => {
    expect(evaluate([exam]).status).toBe("complete");
    expect(evaluate([]).status).toBe("incomplete");
    expect(evaluate([{ ...exam, resultAvailable: false }]).status).toBe("incomplete");
    expect(evaluate([{ ...exam, resultAvailable: null }]).status).toBe("unknown");
    expect(evaluate([{ ...exam, expiresOn: null }]).status).toBe("unknown");
    expect(evaluate([{ ...exam, performedOn: null }]).status).toBe("unknown");
    expect(evaluate([{ ...exam, expiresOn: "2026-09-19" }]).status).toBe("expired");
  });
  it("условие не домысливается, явная неприменимость не требует результат", () => {
    const conditional = { ...catalogue, profiles: [{ profile: "тестовый", requirements: [{ ...catalogue.profiles[0].requirements[0], conditional: true }] }] };
    expect(evaluateCompleteness({ profile: "тестовый", scheduledDate: null, examinations: [] }, conditional, now).status).toBe("unknown");
    expect(evaluateCompleteness({ profile: "тестовый", scheduledDate: null, examinations: [{ ...exam, applicability: "no", resultAvailable: false }] }, conditional, now).status).toBe("complete");
  });
  it("считает годность на целевую дату и использует календарь UTC+5", () => {
    expect(localDate(Date.parse("2026-09-13T20:00:00Z"))).toBe("2026-09-14");
    expect(isCalendarDate("2024-02-29")).toBe(true);
    expect(isCalendarDate("2026-02-29")).toBe(false);
    const computed = { ...catalogue, profiles: [{ profile: "тестовый", requirements: [{ ...catalogue.profiles[0].requirements[0], validForDays: 10 }] }] };
    const result = evaluateCompleteness({ profile: "тестовый", scheduledDate: "2026-09-20", examinations: [{ ...exam, expiresOn: null }] }, computed, now);
    expect(result.entries[0].expiresOn).toBe("2026-09-20");
    expect(result.basis).toBe("scheduled_date");
    expect(result.status).toBe("complete");
    const limited = evaluateCompleteness({ profile: "тестовый", scheduledDate: "2026-09-21", examinations: [{ ...exam, expiresOn: "2099-01-01" }] }, computed, now);
    expect(limited.status).toBe("expired");
    expect(limited.entries[0].expiresOn).toBe("2026-09-20");
  });
});

describe("агрегаты и устойчивость", () => {
  it("аналитику не раскрывает малую корзину через total, врачу ограничивает область", async () => {
    const { service } = setup();
    for (let i = 0; i < 5; i++) await service.create(doctor, createInput(`a${i}`));
    const visible = await service.aggregates(analyst);
    expect(visible).toMatchObject({ total: 5, suppressed: false, forecast: null });
    expect(JSON.stringify(visible)).not.toContain("patientLabel");
    expect(JSON.stringify(visible)).not.toContain("doctor-a");
    const other = await service.create(colleague, createInput("b"));
    await service.update(colleague, other.id, { expectedRevision: 1, idempotencyKey: "wait", patch: { queue: true } });
    expect(await service.aggregates(analyst)).toMatchObject({ total: null, suppressed: true, groups: [] });
    expect(await service.aggregates(doctor)).toMatchObject({ total: 5, scope: "own" });
  });
  it("не сбрасывает время этапа из-за изменения обследования", async () => {
    const { service, advance } = setup();
    const r = await service.create(doctor, createInput());
    await service.update(doctor, r.id, { expectedRevision: 1, idempotencyKey: "wait", patch: { queue: true } });
    advance(2);
    const { id: _id, ...record } = exam;
    void _id;
    await service.examination(doctor, r.id, { expectedRevision: 2, idempotencyKey: "exam", record });
    advance(1);
    expect((await service.aggregates(doctor)).groups[0]).toMatchObject({ flow: "waiting", meanObservedDays: 3, observedTimeCount: 1 });
    expect((await service.detail(doctor, r.id)).observedStageDays).toBe(3);
  });
  it("не придумывает время динамической готовности", async () => {
    const service = new ReferralService(new MemoryReferralRepository(), { now: () => now, catalogue });
    const r = await service.create(doctor, createInput());
    const { id: _id, ...record } = exam;
    void _id;
    await service.examination(doctor, r.id, { expectedRevision: 1, idempotencyKey: "exam", record });
    expect((await service.aggregates(doctor)).groups[0]).toMatchObject({ flow: "ready", meanObservedDays: null, observedTimeCount: 0 });
    expect((await service.detail(doctor, r.id)).observedStageDays).toBeNull();
  });
  it("показывает фиксированную историю наблюдений только в разрешённой области", async () => {
    const { service, advance } = setup();
    const first = await service.create(doctor, createInput("first"));
    advance(1);
    await service.update(doctor, first.id, { expectedRevision: 1, idempotencyKey: "wait", patch: { queue: true } });
    await service.create(colleague, { ...createInput("other"), profile: "Чужой профиль" });
    advance(1);
    await service.update(doctor, first.id, { expectedRevision: 2, idempotencyKey: "scheduled", patch: { scheduledDate: "2026-09-20" } });
    const result = await service.aggregates(doctor);
    expect(result.timeline).toHaveLength(30);
    expect(result.period.to).toBe("2026-09-15");
    expect(result.timeline.slice(-3)).toEqual([
      { date: "2026-09-13", createdCount: 1, totalCount: 1, waitingCount: 0 },
      { date: "2026-09-14", createdCount: 0, totalCount: 1, waitingCount: 1 },
      { date: "2026-09-15", createdCount: 0, totalCount: 1, waitingCount: 0 },
    ]);
    expect(result.timelineSource).toBe("observed_snapshot");
    expect(result.perProfile).toEqual([{ profile: "тестовый", count: 1 }]);
    const restricted = await service.aggregates(analyst);
    expect(restricted.timeline).toEqual([]);
    expect(restricted.perProfile).toEqual([]);
    expect(restricted.timelineUnavailableReason).toBe("not_available_for_analyst");
    expect(JSON.stringify(restricted)).not.toContain("Чужой профиль");
  });
  it("не выдаёт среднее по одному известному времени внутри большой группы", async () => {
    const { service } = setup();
    for (let i = 0; i < 5; i++) {
      const r = await service.create(doctor, createInput(`mixed-${i}`));
      if (i < 4) {
        const { id: _id, ...record } = exam;
        void _id;
        await service.examination(doctor, r.id, { expectedRevision: 1, idempotencyKey: `exam-${i}`, record });
      }
    }
    expect(await service.aggregates(analyst)).toMatchObject({ suppressed: true, total: null, groups: [] });
  });
  it("возвращает detached данные и отвергает повреждённую историю", async () => {
    const { service, repository } = setup();
    const r = await service.create(doctor, createInput());
    r.patientLabel = "changed";
    expect((await service.detail(doctor, r.id)).patientLabel).toBe("Эпизод 1");
    const state = await repository.read((value) => structuredClone(value)) as ReferralDatabase;
    state.referrals[0].queue = true;
    expect(() => validateReferralDatabase(state)).toThrow("Invalid referral snapshot");
  });
  it("валидатор обнаруживает повреждение вложенного снимка, цепочки и команд", async () => {
    const { service, repository } = setup();
    await service.bindLink("token", doctor);
    const r = await service.create(doctor, { ...createInput(), sourceSessionId: "source" }, { sessionId: "source", doctorToken: "token", result: triage });
    await service.update(doctor, r.id, { expectedRevision: 1, idempotencyKey: "q", patch: { queue: true } });
    const original = await repository.read((state) => structuredClone(state));
    const corruptions: ((state: ReferralDatabase) => void)[] = [
      (state) => { state.referrals[0].triageSnapshot!.anamnesis.symptom.severity = Number.NaN; },
      (state) => { state.referrals[0].triageSnapshot!.hypothesis.confidence = 2; },
      (state) => { state.referrals[0].triageSnapshot!.hypothesis.confidence = 0.1; },
      (state) => { state.referrals[0].triageSnapshot!.hypothesis.disclaimer = "placeholder"; },
      (state) => { state.referrals[0].triageSnapshot!.red_flags = [{ code: "chest_pain", label: "Боль в груди", evidence: "Боль в груди", evidence_kind: "quote", emergency: true, source_message_index: 0 }]; },
      (state) => { Object.assign(state.referrals[0].triageSnapshot!, { messages: [] }); },
      (state) => { state.referrals[0].events[1].before = null; },
      (state) => { state.referrals[0].events[1].id = state.referrals[0].events[0].id; },
      (state) => { state.referrals[0].events[1].occurredAt = now + 1; },
      (state) => { state.referrals[0].updatedAt += 1; },
      (state) => { state.commands.push(state.commands[0]); },
      (state) => { state.commands[0].organizationId = "other"; },
    ];
    for (const corrupt of corruptions) {
      const candidate = structuredClone(original);
      corrupt(candidate);
      expect(() => validateReferralDatabase(candidate)).toThrow("Invalid referral snapshot");
    }
    await expect(repository.transaction((state) => { state.referrals[0].revision = 100; })).rejects.toThrow("Invalid referral snapshot");
    expect((await service.detail(doctor, r.id)).revision).toBe(2);
  });
  it("переживает закрытие и повторное открытие файлового хранилища", async () => {
    const directory = await mkdtemp(join(tmpdir(), "demeu-referrals-"));
    let repository = new FileReferralRepository(join(directory, "referrals.json"));
    try {
      const service = new ReferralService(repository, { now: () => now });
      await service.bindLink("token", doctor);
      const r = await service.create(doctor, createInput());
      await service.update(doctor, r.id, { expectedRevision: 1, idempotencyKey: "q", patch: { queue: true } });
      await repository.close();
      repository = new FileReferralRepository(join(directory, "referrals.json"));
      const reopened = new ReferralService(repository, { now: () => now });
      expect(await reopened.detail(doctor, r.id)).toMatchObject({ revision: 2, queue: true });
      expect(await reopened.ownerForToken("token")).toEqual(doctor);
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
