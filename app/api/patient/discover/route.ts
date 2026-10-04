import { handleDiscoverPreparation } from "@/lib/patient-package";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request) { return handleDiscoverPreparation(req); }
