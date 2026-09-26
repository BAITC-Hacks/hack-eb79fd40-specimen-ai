import { handleReferral } from "@/lib/workspace-api";
import { patientMemoFromReferral, renderPatientMemoPdf } from "@/lib/patient-memo";
import type { ReferralDetail } from "@/lib/referrals/types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const response = await handleReferral(req, (await context.params).id);
  if (!response.ok) return response;
  try {
    const { referral } = await response.json() as { referral: ReferralDetail };
    const memo = patientMemoFromReferral(referral);
    if (new URL(req.url).searchParams.get("format") !== "pdf") {
      return Response.json({ memo }, { headers: { "Cache-Control": "no-store" } });
    }
    const pdf = await renderPatientMemoPdf(memo);
    return new Response(Uint8Array.from(pdf).buffer, { headers: {
      "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="demeu-patient-memo.pdf"',
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    } });
  } catch {
    return Response.json({ code: "PDF_UNAVAILABLE", error: "Памятка PDF временно недоступна" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
