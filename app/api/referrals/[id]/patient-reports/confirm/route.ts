import { handleConfirmPreparation } from "@/lib/patient-package";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) { return handleConfirmPreparation(req, (await context.params).id); }
