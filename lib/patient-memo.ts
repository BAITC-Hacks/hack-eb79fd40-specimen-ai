import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PageSizes, rgb } from "pdf-lib";
import type { PatientMemo, ReferralDetail } from "./referrals/types";

const ACTIONS = {
  present: "взять актуальный результат с собой",
  missing: "получить результат и взять его с собой",
  expired: "обновить результат и взять его с собой",
  unknown: "уточнить у врача, нужен ли актуальный результат",
  not_applicable: "не требуется по решению врача",
} as const;
const displayDate = (value: string) => value.split("-").reverse().join(".");

// Both the download route and Telegram build the memo from the completeness
// calculated against the referral's persisted requirementSnapshot. A newer
// catalogue must not silently rewrite an existing episode package.
export function patientMemoFromReferral(referral: ReferralDetail): PatientMemo {
  const items = referral.completeness.entries.length > 0
    ? referral.completeness.entries
      .filter((entry) => entry.status !== "not_applicable")
      .map(({ label, status, expiresOn }) => ({ label, status, expiresOn }))
    : referral.examinations.map((record) => ({
      label: record.label,
      status: "unknown" as const,
      expiresOn: record.expiresOn,
    }));
  return {
    patientLabel: referral.patientLabel,
    scheduledDate: referral.scheduledDate,
    destinationOrganization: referral.destinationOrganization,
    catalogueAvailable: referral.completeness.catalogueAvailable,
    items,
  };
}

// Patient-facing whitelist: no transcript, hypothesis, risk score or snapshot.
export function renderPatientMemoText(memo: PatientMemo): string {
  return [
    "Demeu · Памятка по подготовке",
    `Пациент: ${memo.patientLabel}`,
    `Организация: ${memo.destinationOrganization ?? "уточнить у врача"}`,
    `Целевая дата госпитализации: ${memo.scheduledDate ? displayDate(memo.scheduledDate) : "не указана"}`,
    memo.catalogueAvailable
      ? "Что взять с собой к целевой дате:"
      : "Справочник ещё не проверен врачом больницы. Состав пакета ниже не подтверждён; уточните его у врача.",
    ...memo.items.map((item, index) => `${index + 1}. ${item.label} — ${ACTIONS[item.status]}${item.expiresOn ? `; срок действия до ${displayDate(item.expiresOn)}` : "; срок действия уточните у врача"}`),
    "Назначенная дата не подтверждает явку. При изменении планов свяжитесь с врачом.",
    "Окончательный состав пакета и готовность подтверждает врач.",
    "Demeu не отправляет данные в Портал бюро госпитализации.",
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
    if (!paragraph) { line(""); continue; }
    let current = "";
    for (const word of paragraph.split(/\s+/u)) {
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= width) { current = candidate; continue; }
      if (current) { line(current); current = ""; }
      if (font.widthOfTextAtSize(word, size) <= width) { current = word; continue; }
      for (const char of word) {
        if (font.widthOfTextAtSize(current + char, size) > width && current) { line(current); current = ""; }
        current += char;
      }
    }
    line(current);
  }
  return document.save();
}
