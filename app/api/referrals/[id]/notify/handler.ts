import { readWorkspaceBody, workspaceBoundary } from "@/lib/workspace-api";
import { assertSameOrigin, requireWorkspaceActor, WorkspaceAuthError } from "@/lib/workspace-auth";
import { workspace } from "@/lib/workspace";
import { scopedWorkspaceNotifier } from "@/lib/workspace-notifier";
import type { PatientMemo, ReferralActor, ReferralDetail } from "@/lib/referrals/types";

interface NotifyDeps {
  actor?: (req: Request) => Promise<ReferralActor>;
  detail?: (actor: ReferralActor, id: string) => Promise<ReferralDetail>;
  send?: (actor: ReferralActor, referral: ReferralDetail, memo: PatientMemo, key: string) => Promise<{ sent: true }>;
}

export function handleReferralNotify(req: Request, id: string, deps: NotifyDeps = {}) {
  return workspaceBoundary(async () => {
    if (req.method !== "POST") throw new WorkspaceAuthError(405, "METHOD_NOT_ALLOWED");
    const actor = await (deps.actor ?? requireWorkspaceActor)(req);
    assertSameOrigin(req);
    if (actor.role === "analyst") throw new WorkspaceAuthError(403, "FORBIDDEN");
    const body = await readWorkspaceBody(req, ["expectedRevision", "idempotencyKey"]);
    if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1 || typeof body.idempotencyKey !== "string" || !/^[a-zA-Z0-9-]{8,128}$/u.test(body.idempotencyKey)) throw new WorkspaceAuthError(400, "BAD_REQUEST");
    const referral = await (deps.detail ?? ((user, key) => workspace().detail(user, key)))(actor, id);
    if (referral.organizationId !== actor.organizationId || (actor.role !== "owner" && referral.doctorId !== actor.id)) throw new WorkspaceAuthError(403, "FORBIDDEN");
    if (referral.revision !== body.expectedRevision) throw new WorkspaceAuthError(409, "REVISION_CONFLICT");
    const memo: PatientMemo = {
      patientLabel: referral.patientLabel, scheduledDate: referral.scheduledDate,
      destinationOrganization: referral.destinationOrganization,
      catalogueAvailable: referral.completeness.catalogueAvailable,
      items: referral.completeness.catalogueAvailable
        ? referral.completeness.entries.filter((entry) => entry.status !== "not_applicable")
          .map(({ label, status, expiresOn }) => ({ label, status, expiresOn }))
        : referral.examinations.map((record) => {
          const entry = referral.completeness.entries.find((item) => item.requirementId === record.requirementId);
          return { label: record.label, status: entry?.status ?? "unknown" as const, expiresOn: record.expiresOn };
        }),
    };
    const result = await (deps.send ?? ((user, record, patientMemo, key) => scopedWorkspaceNotifier().sendReferral(user, record, patientMemo, key)))(actor, referral, memo, body.idempotencyKey);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  });
}
