import { handleRegistrationSnapshot } from "@/lib/workspace-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return handleRegistrationSnapshot(req, (await context.params).id);
}
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  return handleRegistrationSnapshot(req, (await context.params).id);
}
