import { handleDoctorAssessment } from "@/lib/workspace-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return handleDoctorAssessment(req, (await context.params).id);
}
