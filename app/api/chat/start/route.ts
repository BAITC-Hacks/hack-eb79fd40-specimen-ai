import { NextRequest } from "next/server";
import { handleChatStart } from "./handler";
import { store } from "@/lib/store";
import { protectPatientStart } from "@/lib/patient-session";
import { withSessionSweep } from "@/lib/session-operations";
import { attachStartedPreparation } from "@/lib/patient-package";
import { workspaceConfigured } from "@/lib/workspace-auth";
import { readSessionBody } from "@/lib/request-body";

export async function POST(req: NextRequest) {
  const input = await readSessionBody(req).catch(() => null);
  const response = await protectPatientStart(req, () => withSessionSweep(() => handleChatStart(req, store())));
  return workspaceConfigured() && typeof input?.token === "string" ? attachStartedPreparation(response, input.token) : response;
}
