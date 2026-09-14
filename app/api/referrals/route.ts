import { handleReferrals } from "@/lib/workspace-api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(req: Request) { return handleReferrals(req); }
export function POST(req: Request) { return handleReferrals(req); }
