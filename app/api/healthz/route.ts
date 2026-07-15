import { NextResponse } from "next/server";
import { buildHealthResponse } from "@/lib/health";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(buildHealthResponse(), { status: 200 });
}
