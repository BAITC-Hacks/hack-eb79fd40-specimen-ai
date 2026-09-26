import { handleWorkspaceAggregateDashboard } from "./handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(req: Request) { return handleWorkspaceAggregateDashboard(req); }
