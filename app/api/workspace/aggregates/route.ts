import { handleWorkspaceAggregates } from "@/lib/workspace-api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(req: Request) { return handleWorkspaceAggregates(req); }
