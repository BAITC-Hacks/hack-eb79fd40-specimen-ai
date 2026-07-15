import { NextResponse } from "next/server";
import { store } from "@/lib/store";

// Врач генерирует персональную ссылку для пациента.
export async function POST() {
  try {
    const token = await store().createDoctorToken();
    return NextResponse.json({ token });
  } catch {
    return NextResponse.json(
      { error: "Не удалось создать ссылку", code: "INTERNAL" },
      { status: 500 },
    );
  }
}
