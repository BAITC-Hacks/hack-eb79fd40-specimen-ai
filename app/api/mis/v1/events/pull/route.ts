import { handleMisPull } from "@/lib/mis/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request) { return handleMisPull(req); }
