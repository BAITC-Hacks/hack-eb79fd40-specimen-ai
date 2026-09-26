import type { ReferralAggregates } from "@/lib/referrals/types";
import { handleWorkspaceAggregates, type WorkspaceApiDeps, workspaceBoundary } from "@/lib/workspace-api";
import { requireWorkspaceActor, workspaceAccessScope } from "@/lib/workspace-auth";

export type WorkspaceAggregatePayload = {
  access: ReturnType<typeof workspaceAccessScope>;
  aggregates: ReferralAggregates;
};

export function projectWorkspaceAggregates(
  role: "owner" | "doctor" | "analyst",
  aggregates: ReferralAggregates,
): WorkspaceAggregatePayload {
  const access = workspaceAccessScope(role);
  return { access, aggregates };
}

export function handleWorkspaceAggregateDashboard(req: Request, deps: WorkspaceApiDeps = {}): Promise<Response> {
  return workspaceBoundary(async () => {
    const actor = await (deps.actor ?? requireWorkspaceActor)(req);
    const response = await handleWorkspaceAggregates(req, { ...deps, actor: async () => actor });
    if (!response.ok) return response;
    const body = await response.json() as { aggregates: ReferralAggregates };
    return Response.json(projectWorkspaceAggregates(actor.role, body.aggregates), {
      headers: { "Cache-Control": "no-store" },
    });
  });
}
