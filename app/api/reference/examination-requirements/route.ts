import { handleExaminationRequirementsReference } from "@/lib/reference-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return handleExaminationRequirementsReference(req);
}

export function HEAD(req: Request) {
  return handleExaminationRequirementsReference(req);
}
