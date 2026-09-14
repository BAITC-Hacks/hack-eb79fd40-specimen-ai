import { handleReferralNotify } from "./handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return handleReferralNotify(req, (await context.params).id);
}
