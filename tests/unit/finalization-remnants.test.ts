import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileReferralRepository, ReferralService, REFERRAL_DATABASE_SCHEMA_VERSION } from "../../lib/referrals/service";
import { MisService } from "../../lib/mis/service";
import { reconcileMisEvent } from "../../lib/mis/projection";
import { cleanupInstallationCheck, INSTALLATION_CHECK_REFERRAL_ID } from "../../scripts/cleanup-referrals-snapshot";
import { renderAbortedNotice } from "../../lib/telegram";
import type { ReferralActor, RequirementCatalogue } from "../../lib/referrals/types";
import { FRONTEND_RESULT } from "../fixtures/frontend-result";

const doctor: ReferralActor = { id: "doctor-a", displayName: "Врач", role: "doctor", organizationId: "clinic" };
const at = Date.parse("2026-10-04T08:00:00Z");
const catalogue: RequirementCatalogue = { schemaVersion: 1, version: "cleanup-test", status: "available", source: "synthetic-test-only", validated: false,
  scope: { population: "adult", careSetting: "inpatient", treatment: "operative" }, profiles: [{ profile: "Хирургический", requirements: [
    { id: "cbc", label: "Исследование", required: true, conditional: false, validForDays: 30 },
  ] }] };

describe("finalization remnants", () => {
  it("aborted notification exposes only an authenticated scoped URL, never a doctor capability or naked session label", () => {
    const text = renderAbortedNotice({ sessionId: "episode", doctorToken: "private-doctor-token", startedAt: at, abortedAt: at + 60_000,
      reason: "injected\nprivate-doctor-token" }, { doctorDisplayName: "Врач\nА", episodeLabel: "Опрос", intakeUrl: "https://example.test/workspace/intakes/episode" });
    expect(text).toContain("https://example.test/workspace/intakes/episode");
    expect(text).not.toContain("private-doctor-token");
    expect(text).not.toContain("Сессия:");
    expect(text).not.toContain("injected");
    expect(text).toContain("Причина: опрос прерван");
  });

  it("cascades only the selected synthetic schema6 episode and preserves writable unrelated source/grant/claim/MIS history beyond chat retention", async () => {
    const directory = await mkdtemp(join(tmpdir(), "demeu-remnants-"));
    const path = join(directory, "referrals.json");
    const repository = new FileReferralRepository(path);
    let restored: FileReferralRepository | undefined;
    try {
      const service = new ReferralService(repository, { now: () => at, catalogue });
      const episodes: { grant: Awaited<ReturnType<ReferralService["issuePreparation"]>>; referral: Awaited<ReturnType<ReferralService["assess"]>> }[] = [];
      for (let index = 0; index < 2; index++) {
        const token = index ? "abcdef0123456789" : "0123456789abcdef";
        const sourceSessionId = `source-${index}`;
        await service.bindLink(token, doctor);
        const grant = await service.issuePreparation(sourceSessionId, doctor, token);
        const created = await service.create(doctor, { patientLabel: `Synthetic ${index}`, profile: "Хирургический", sourceSessionId, idempotencyKey: `create-${index}` },
          { sessionId: sourceSessionId, doctorToken: token, result: FRONTEND_RESULT });
        const assessed = await service.assess(doctor, created.id, { expectedRevision: created.revision, expectedAssessmentRevision: 0, idempotencyKey: `assess-${index}`,
          reason: "Synthetic test", assessment: { hypothesis: "Предварительная гипотеза", profile: "Хирургический", icd10Code: "I20.9", careContext: "operative" } });
        await service.reportPreparation(grant.token, grant.accessId, { requirementId: "cbc", performedOn: "2026-10-01", resultAvailable: true, expectedRevision: 0, idempotencyKey: `claim-${index}` });
        await repository.transaction((state) => {
          const record = state.referrals.find((entry) => entry.id === assessed.id)!;
          reconcileMisEvent(state, record, "referral.readiness.changed", { state: "not_ready", reasonCodes: ["CATALOGUE_UNVALIDATED"], evaluatedOn: "2026-10-04" }, at, () => `event-${index}`, true);
        });
        episodes.push({ grant, referral: assessed });
      }
      const mis = new MisService(repository, { now: () => at + 1, risk: { evaluate: async () => ({ status: "unavailable", researchOnly: true, reason: "ARTIFACT_UNAVAILABLE" }) }, researchEventsEnabled: false });
      const principal = { integrationId: "mis", credentialId: "key", organizationId: doctor.organizationId, scopes: ["events:pull", "events:ack"] as const };
      for (const event of (await mis.pull(principal, 10)).events) {
        await mis.ack(principal, event.eventId, { deliveryId: event.deliveryId, idempotencyKey: `ack-${event.eventId}` });
      }
      const original = await repository.read((state) => structuredClone(state));
      expect(original.schemaVersion).toBe(REFERRAL_DATABASE_SCHEMA_VERSION);
      // Bind the exact installation fixture while preserving its genuine audited relations.
      const targetId = episodes[0].referral.id;
      const source = JSON.parse(JSON.stringify(original).replaceAll(targetId, INSTALLATION_CHECK_REFERRAL_ID));
      const cleaned = cleanupInstallationCheck(source);
      expect(cleaned.snapshot.referrals).toEqual(original.referrals.slice(1));
      expect(cleaned.snapshot.links).toEqual(original.links);
      expect(cleaned.snapshot.patientAccess).toEqual(original.patientAccess?.filter((entry) => entry.referralId === episodes[1].referral.id));
      expect(cleaned.snapshot.patientReports).toEqual(original.patientReports?.filter((entry) => entry.referralId === episodes[1].referral.id));
      expect(cleaned.snapshot.commands).toEqual(original.commands.filter((entry) => entry.referralId === episodes[1].referral.id));
      expect(cleaned.snapshot.misOutbox).toEqual(original.misOutbox?.filter((entry) => entry.referralId === episodes[1].referral.id));
      const keptEventIds = new Set(original.misOutbox?.filter((entry) => entry.referralId === episodes[1].referral.id).map((entry) => entry.eventId));
      expect(cleaned.snapshot.misCommands).toEqual(original.misCommands?.filter((entry) => keptEventIds.has(entry.eventId)));
      expect(cleaned.snapshot.patientReports).toHaveLength(1);
      expect(cleaned.snapshot.misCommands).toHaveLength(1);
      const candidate = join(directory, "candidate.json");
      await writeFile(candidate, JSON.stringify(cleaned.snapshot), { mode: 0o600 });
      restored = new FileReferralRepository(candidate);
      const reopened = new ReferralService(restored, { now: () => at + 2 * 86_400_000, catalogue });
      expect(await reopened.preparation(episodes[1].grant.token)).toMatchObject({ state: "preparing", patientLabel: "Synthetic 1", items: [{ selfReport: { resultAvailable: true } }] });
      await expect(reopened.preparation(episodes[0].grant.token)).rejects.toMatchObject({ status: 401 });
      await reopened.update(doctor, episodes[1].referral.id, { expectedRevision: episodes[1].referral.revision,
        idempotencyKey: "post-cleanup-write", patch: { destinationOrganization: "Writable" } });
      expect(JSON.parse(await readFile(candidate, "utf8")).referrals[0].destinationOrganization).toBe("Writable");
    } finally { await restored?.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("bakes only the schema marker and excludes orchestration artifacts from the runtime build", async () => {
    const dockerfile = await readFile("Dockerfile", "utf8");
    const ignored = await readFile(".dockerignore", "utf8");
    expect(dockerfile).toContain("/app/deploy/referral-schema-version ./referral-schema-version");
    expect(ignored).toContain(".unlazy/");
    expect(ignored).toContain("!deploy/referral-schema-version");
    expect(Number((await readFile("deploy/referral-schema-version", "utf8")).trim())).toBe(REFERRAL_DATABASE_SCHEMA_VERSION);
  });

});
