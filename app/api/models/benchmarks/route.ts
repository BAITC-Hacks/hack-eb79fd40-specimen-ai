import { handleModelBenchmarks } from "@/lib/model-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return handleModelBenchmarks(req);
}
