import { NextRequest } from "next/server";
import { handleFinalize } from "./handler";
import { store } from "@/lib/store";
import { protectPatientAction } from "@/lib/patient-session";
import { withSessionRequest } from "@/lib/session-operations";

export async function POST(req: NextRequest) {
  const sessionStore = store();
  return withSessionRequest(req, () => protectPatientAction(req, sessionStore, () => handleFinalize(req, { sessionStore })));
}
