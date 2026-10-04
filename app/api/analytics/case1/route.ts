import { handleCase1Analytics } from "@/lib/case1-analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return handleCase1Analytics(req);
}

export function HEAD(req: Request) {
  return handleCase1Analytics(req);
}
