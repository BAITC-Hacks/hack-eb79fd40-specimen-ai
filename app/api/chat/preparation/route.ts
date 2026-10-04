import { store } from "@/lib/store";
import { protectPatientAction } from "@/lib/patient-session";
import { attachStartedPreparation } from "@/lib/patient-package";
import { readSessionBody } from "@/lib/request-body";
import { withSessionRequest } from "@/lib/session-operations";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  const sessionStore = store();
  return withSessionRequest(req, () => protectPatientAction(req, sessionStore, async () => {
    const input = await readSessionBody(req);
    const session = await sessionStore.getSession(String(input.sessionId));
    if (!session) return Response.json({ code: "SESSION_NOT_FOUND" }, { status: 404 });
    return attachStartedPreparation(Response.json({ sessionId: session.id }), session.doctorToken);
  }));
}
