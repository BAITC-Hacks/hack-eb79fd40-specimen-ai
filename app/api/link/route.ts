import { NextResponse } from "next/server";
import { createDoctorToken } from "@/lib/store";

// Врач генерирует персональную ссылку для пациента.
export async function POST() {
  const token = createDoctorToken();
  return NextResponse.json({ token });
}
