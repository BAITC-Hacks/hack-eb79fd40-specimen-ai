import { handleMisAck } from "@/lib/mis/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, context: { params: Promise<{ eventId: string }> }) {
  return handleMisAck(req, (await context.params).eventId);
}
