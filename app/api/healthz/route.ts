import { NextRequest, NextResponse } from "next/server";
import { handleHealthRequest } from "@/lib/health-deep";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const result = await handleHealthRequest(request);
  return NextResponse.json(result.body, { status: result.status });
}
