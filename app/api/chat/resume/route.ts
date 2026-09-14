import { store } from "@/lib/store";
import { resumePatientSession } from "@/lib/patient-session";
import { withSessionRequest } from "@/lib/session-operations";

export async function POST(req: Request) {
  return withSessionRequest(req, () => resumePatientSession(req, store()));
}
