import { NextRequest } from "next/server";
import { handleChatStart } from "./handler";
import { store } from "@/lib/store";
import { protectPatientStart } from "@/lib/patient-session";
import { withSessionSweep } from "@/lib/session-operations";

export async function POST(req: NextRequest) {
  return protectPatientStart(req, () => withSessionSweep(() => handleChatStart(req, store())));
}
