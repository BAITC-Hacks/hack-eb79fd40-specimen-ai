import { store } from "@/lib/store";
import { resumePatientSession } from "@/lib/patient-session";
import { patientSafeResumeResponse } from "@/lib/patient-response";
import { withSessionRequest } from "@/lib/session-operations";

export async function POST(req: Request) {
  return withSessionRequest(req, async () => {
    return patientSafeResumeResponse(await resumePatientSession(req, store()));
  });
}
