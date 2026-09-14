import { store } from "@/lib/store";
import { linkRateLimiter } from "@/lib/rate-limit";
import { handleLink } from "./handler";
import { workspaceConfigured } from "@/lib/workspace-auth";
import { handleWorkspaceLink } from "@/lib/workspace-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Врач генерирует персональную ссылку для пациента.
export async function POST(req: Request) {
  if (workspaceConfigured()) return handleWorkspaceLink(req);
  return handleLink(req, {
    sessionStore: { createDoctorToken: () => store().createDoctorToken() },
    limiter: linkRateLimiter(),
    accessCode: process.env.DOCTOR_ACCESS_CODE,
  });
}
