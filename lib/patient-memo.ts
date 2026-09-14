import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PageSizes, rgb } from "pdf-lib";
import type { PatientMemo } from "./referrals/types";

const LABELS = { present: "есть", missing: "отсутствует", expired: "срок истёк", unknown: "уточнить у врача", not_applicable: "не требуется" };

// Patient-facing whitelist: no transcript, hypothesis, risk score or snapshot.
export function renderPatientMemoText(memo: PatientMemo): string {
  return [
    "Demeu · Памятка по подготовке",
    `Пациент: ${memo.patientLabel}`,
    `Организация: ${memo.destinationOrganization ?? "уточнить у врача"}`,
    `Назначенная дата: ${memo.scheduledDate ?? "не указана"}`,
    memo.catalogueAvailable ? "Проверьте обследования перед посещением:" : "Перечень обязательных обследований не проверен. Уточните состав пакета у врача.",
    ...memo.items.map((item) => `${item.label}: ${LABELS[item.status]}${item.expiresOn ? `; действует до ${item.expiresOn}` : ""}`),
    "Назначенная дата не подтверждает явку. При изменении планов свяжитесь с врачом.",
  ].join("\n");
}

export async function renderPatientMemoPdf(memo: PatientMemo): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  const font = await document.embedFont(await readFile(resolve(process.cwd(), "assets/fonts/IBMPlexSans-Variable.ttf")), { subset: true });
  const supported = new Set(font.getCharacterSet());
  const text = [...renderPatientMemoText(memo)].map((char) => char === "\n" || supported.has(char.codePointAt(0)!) ? char : " ").join("");
  let page = document.addPage(PageSizes.A4);
  let y = page.getHeight() - 48;
  const size = 11;
  const width = page.getWidth() - 96;
  function line(value: string) {
    if (y < 48) { page = document.addPage(PageSizes.A4); y = page.getHeight() - 48; }
    page.drawText(value, { x: 48, y, size, font, color: rgb(0.13, 0.19, 0.16) });
    y -= 17;
  }
  for (const paragraph of text.split("\n")) {
    let current = "";
    for (const char of paragraph) {
      if (font.widthOfTextAtSize(current + char, size) > width && current) { line(current); current = ""; }
      current += char;
    }
    line(current);
  }
  return document.save();
}
