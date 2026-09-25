import { handleWorkspaceIntake } from "@/lib/workspace-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  return handleWorkspaceIntake(req, (await context.params).id);
}
