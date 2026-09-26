import { handleModelDetail } from "@/lib/model-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  return context.params.then(({ id }) => handleModelDetail(req, id));
}
