import { handleWorkspaceAuth } from "@/lib/workspace-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handleWorkspaceAuth;
export const POST = handleWorkspaceAuth;
export const DELETE = handleWorkspaceAuth;
