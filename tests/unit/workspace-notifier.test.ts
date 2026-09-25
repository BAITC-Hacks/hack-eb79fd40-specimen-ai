import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { DeliveryJournal, ScopedWorkspaceNotifier, workspaceNotifierFromEnv } from "../../lib/workspace-notifier";
import { renderPatientMemoPdf, renderPatientMemoText } from "../../lib/patient-memo";
import type { PatientMemo, ReferralActor, ReferralDetail } from "../../lib/referrals/types";
import { handleReferralNotify } from "../../app/api/referrals/[id]/notify/handler";
import type { ReadonlySession, TriageResult } from "../../lib/types";

const directories: string[] = [];
const journals: DeliveryJournal[] = [];
beforeEach(() => vi.stubEnv("APP_BASE_URL", "https://demeu.example.test/base"));
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(journals.splice(0).map((journal) => journal.close())); await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function journalFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "demeu-delivery-")); directories.push(directory);
  const filename = path.join(directory, "deliveries.json");
  const journal = new DeliveryJournal(filename); journals.push(journal);
  return { journal, filename };
}
const owner: ReferralActor = { id: "doctor-1", displayName: "Врач", role: "doctor", organizationId: "org-1", telegramChatId: "123" };
const memo: PatientMemo = { patientLabel: "Пациент А", scheduledDate: null, destinationOrganization: null, catalogueAvailable: false, items: [{ label: "Обследование", status: "unknown", expiresOn: null }] };
const referral = { id: "ref-1", doctorId: owner.id, organizationId: owner.organizationId, revision: 1, profile: "Профиль", patientLabel: memo.patientLabel, scheduledDate: null, destinationOrganization: null, triageSnapshot: { urgency: "urgent" }, completeness: { status: "unknown", catalogueAvailable: false, entries: [] }, examinations: [] } as unknown as ReferralDetail;

describe("durable scoped delivery", () => {
  it("persists before sending and replays after restart, including a new key for the same revision", async () => {
    const { journal, filename } = await journalFixture();
    const send = vi.fn(async () => { expect(JSON.parse(await readFile(filename, "utf8")).entries[0].status).toBe("sending"); });
    await journal.deliver("identity", "key1", "payload", send);
    await journal.close();
    const reopened = new DeliveryJournal(filename); journals.push(reopened);
    await expect(reopened.deliver("identity", "key1", "payload", send)).resolves.toEqual({ sent: true });
    await reopened.deliver("identity", "key2", "payload", send);
    await expect(reopened.deliver("other", "key2", "payload", send)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not resend partial failures or sending entries recovered after a crash", async () => {
    const { journal, filename } = await journalFixture();
    const send = vi.fn(async () => { throw new Error("remote timeout with private details"); });
    await expect(journal.deliver("id", "key", "payload", send)).rejects.toMatchObject({ code: "DELIVERY_UNCONFIRMED" });
    await expect(journal.deliver("id", "new-key", "payload", send)).rejects.toMatchObject({ code: "DELIVERY_UNCONFIRMED" });
    await journal.close();
    const value = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
    await writeFile(filename, JSON.stringify({ schemaVersion: 1, entries: [{ identity: value("id"), commands: [value("key")], payloadHash: value("payload"), status: "sending" }] }));
    const reopened = new DeliveryJournal(filename); journals.push(reopened);
    await expect(reopened.deliver("id", "key", "payload", send)).rejects.toMatchObject({ code: "DELIVERY_UNCONFIRMED" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("reserves delivery before a concurrent request can send it again", async () => {
    const { journal } = await journalFixture();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const send = vi.fn(async () => { entered(); await barrier; });
    const first = journal.deliver("id", "key", "payload", send);
    await started;
    await expect(journal.deliver("id", "key", "payload", send)).rejects.toMatchObject({ code: "DELIVERY_UNCONFIRMED" });
    release();
    await first;
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("resolves fresh single recipients for completed/aborted and fails closed when binding changes", async () => {
    const { journal } = await journalFixture();
    let current: ReferralActor | null = owner;
    let binding: ReferralActor | null = owner;
    const summaries = { sendDoctorSummary: vi.fn(async () => undefined), sendAbortedNotice: vi.fn(async () => undefined) };
    const select = vi.fn(() => summaries);
    const notifier = new ScopedWorkspaceNotifier({ ownerForToken: async () => binding, currentActor: async () => current, client: vi.fn(), journal: () => journal, summaryNotifier: select });
    const session = { id: "session-1", doctorToken: "token" } as ReadonlySession;
    await notifier.sendDoctorSummary(session, {} as TriageResult);
    expect(select).toHaveBeenCalledWith("123");
    expect(summaries.sendDoctorSummary).toHaveBeenCalledWith(session, {}, undefined, {
      doctorDisplayName: "Врач",
      episodeLabel: "Новый завершённый опрос",
      intakeUrl: "https://demeu.example.test/workspace/intakes/session-1",
    });
    const notice = { sessionId: "aborted-1", doctorToken: "token", startedAt: 1, abortedAt: 2, reason: "expired" };
    await notifier.sendAbortedNotice(notice);
    current = { ...owner, role: "owner" };
    await notifier.sendAbortedNotice({ ...notice, sessionId: "promoted-doctor" });
    for (const changed of [null, { ...owner, role: "analyst" as const }, { ...owner, organizationId: "other" }, { ...owner, telegramChatId: undefined }]) {
      current = changed;
      await expect(notifier.sendAbortedNotice({ ...notice, sessionId: "new" })).rejects.toMatchObject({ code: "DELIVERY_RECIPIENT_UNAVAILABLE" });
    }
    current = owner; binding = null;
    await expect(notifier.sendDoctorSummary(session, {} as TriageResult)).rejects.toMatchObject({ code: "DELIVERY_RECIPIENT_UNAVAILABLE" });
    expect(select).toHaveBeenCalledTimes(3);
  });

  it("fails the scoped completed summary closed when its canonical intake origin is invalid", async () => {
    vi.stubEnv("APP_BASE_URL", "javascript:alert(1)");
    const { journal } = await journalFixture();
    const summaries = { sendDoctorSummary: vi.fn(async () => undefined), sendAbortedNotice: vi.fn(async () => undefined) };
    const notifier = new ScopedWorkspaceNotifier({ ownerForToken: async () => owner, currentActor: async () => owner, client: vi.fn(), journal: () => journal, summaryNotifier: () => summaries });

    await expect(notifier.sendDoctorSummary({ id: "session-1", doctorToken: "token" } as ReadonlySession, {} as TriageResult))
      .rejects.toMatchObject({ code: "WORKSPACE_UNAVAILABLE" });
    expect(summaries.sendDoctorSummary).not.toHaveBeenCalled();
  });

  it("sends referral text and separate memo PDF once to its doctor, never another user or broadcast", async () => {
    const { journal } = await journalFixture();
    const sent: string[] = [];
    const client = { sendMessage: vi.fn(async (_chatId: string, text: string) => { sent.push(text); }), sendDocument: vi.fn(async () => undefined) };
    const notifier = new ScopedWorkspaceNotifier({ ownerForToken: async () => owner, currentActor: async () => owner, client: () => client, journal: () => journal, pdf: async () => new Uint8Array([1, 2]) });
    await notifier.sendReferral(owner, referral, memo, "key");
    await notifier.sendReferral(owner, referral, memo, "another-key");
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    const text = sent[0]!;
    const lines = text.split("\n");
    expect(lines[0]).toBe("🟠 ПРИОРИТЕТ: СРОЧНО");
    expect(lines[1]).toBe("Эпизод: Пациент А · Врач: Врач");
    expect(lines.at(-1)).toBe("https://demeu.example.test/workspace/referrals/ref-1");
    expect(client.sendDocument).toHaveBeenCalledWith("123", new Uint8Array([1, 2]), "demeu-patient-memo.pdf");
    await expect(notifier.sendReferral({ ...owner, id: "other" }, referral, memo, "key3")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("uses server-owned routing data and keeps untrusted labels on one plain-text line", async () => {
    const { journal } = await journalFixture();
    const recipient = { ...owner, displayName: "Врач\nПодмена" };
    const sent: string[] = [];
    const client = { sendMessage: vi.fn(async (_chatId: string, text: string) => { sent.push(text); }), sendDocument: vi.fn(async () => undefined) };
    const notifier = new ScopedWorkspaceNotifier({ ownerForToken: async () => recipient, currentActor: async () => recipient, client: () => client, journal: () => journal, pdf: async () => new Uint8Array([1]) });
    const organizationOwner = { ...owner, id: "organization-owner", role: "owner" as const };
    const record = { ...referral, patientLabel: "Эпизод\nложный приоритет" };
    await notifier.sendReferral(organizationOwner, record, { ...memo, patientLabel: record.patientLabel }, "safe-lines");
    const text = sent[0]!;
    expect(text.split("\n")[0]).toBe("🟠 ПРИОРИТЕТ: СРОЧНО");
    expect(text.split("\n")[1]).toBe("Эпизод: Эпизод ложный приоритет · Врач: Врач Подмена");
    expect(text.split("\n").at(-1)).toBe("https://demeu.example.test/workspace/referrals/ref-1");
  });

  it("fails closed before delivery when the canonical workspace origin is unavailable", async () => {
    vi.stubEnv("APP_BASE_URL", "https://user:secret@evil.test");
    const { journal } = await journalFixture();
    const client = { sendMessage: vi.fn(async () => undefined), sendDocument: vi.fn(async () => undefined) };
    const notifier = new ScopedWorkspaceNotifier({ ownerForToken: async () => owner, currentActor: async () => owner, client: () => client, journal: () => journal, pdf: async () => new Uint8Array([1]) });
    await expect(notifier.sendReferral(owner, referral, memo, "bad-base")).rejects.toMatchObject({ code: "WORKSPACE_UNAVAILABLE" });
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it("never falls back to global recipient settings under partial workspace configuration", () => {
    vi.stubEnv("DEMEU_AUTH_SECRET", "partial");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("TELEGRAM_DOCTOR_CHAT_IDS", "999,888");
    expect(workspaceNotifierFromEnv()).toBeInstanceOf(ScopedWorkspaceNotifier);
  });

  it("does not resend successful text after an uncertain PDF upload", async () => {
    const { journal } = await journalFixture();
    const client = { sendMessage: vi.fn(async () => undefined), sendDocument: vi.fn(async () => { throw new Error("connection lost"); }) };
    const notifier = new ScopedWorkspaceNotifier({ ownerForToken: async () => owner, currentActor: async () => owner, client: () => client, journal: () => journal, pdf: async () => new Uint8Array([1]) });
    await expect(notifier.sendReferral(owner, referral, memo, "key1")).rejects.toMatchObject({ code: "DELIVERY_UNCONFIRMED" });
    await expect(notifier.sendReferral(owner, referral, memo, "key2")).rejects.toMatchObject({ code: "DELIVERY_UNCONFIRMED" });
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.sendDocument).toHaveBeenCalledTimes(1);
  });
});

describe("patient memo and notification boundary", () => {
  it("renders Cyrillic PDF from a whitelist without clinician-only extras", async () => {
    const extended = { ...memo, hypothesis: "PRIVATE-HYPOTHESIS", transcript: "PRIVATE-TRANSCRIPT", triageSnapshot: { secret: "PRIVATE-SNAPSHOT" } };
    expect(renderPatientMemoText(extended)).not.toMatch(/PRIVATE/u);
    const bytes = await renderPatientMemoPdf(extended);
    expect(Buffer.from(bytes).subarray(0, 4).toString()).toBe("%PDF");
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(0);
  });

  it("enforces origin, role, revision, strict fields and size before sending", async () => {
    vi.stubEnv("APP_BASE_URL", "http://localhost");
    const send = vi.fn(async () => ({ sent: true as const }));
    const detail = vi.fn(async () => referral);
    const deps = { actor: async () => owner, detail, send };
    const request = (body: unknown = { expectedRevision: 1, idempotencyKey: "12345678" }, origin = "http://localhost") => new Request("http://localhost/api/referrals/ref-1/notify", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await handleReferralNotify(request(), "ref-1", deps)).status).toBe(200);
    expect((await handleReferralNotify(request(undefined, "http://evil.test"), "ref-1", deps)).status).toBe(403);
    expect((await handleReferralNotify(request(), "ref-1", { ...deps, actor: async () => ({ ...owner, role: "analyst" }) })).status).toBe(403);
    expect((await handleReferralNotify(request({ expectedRevision: 2, idempotencyKey: "12345678" }), "ref-1", deps)).status).toBe(409);
    expect((await handleReferralNotify(request({ expectedRevision: 1, idempotencyKey: "12345678", chatId: "999" }), "ref-1", deps)).status).toBe(400);
    expect((await handleReferralNotify(request({ expectedRevision: 1, idempotencyKey: "x".repeat(17000) }), "ref-1", deps)).status).toBe(413);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
