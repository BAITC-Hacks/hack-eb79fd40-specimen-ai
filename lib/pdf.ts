import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import fontkit from "@pdf-lib/fontkit";
import {
  PDFDocument,
  PageSizes,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import type {
  ReadonlySession,
  RedFlag,
  TriageResult,
  Urgency,
} from "./types";

const BODY_FONT_PATH = resolve(
  process.cwd(),
  "assets/fonts/IBMPlexSans-Variable.ttf",
);
const SERIF_FONT_PATH = resolve(process.cwd(), "assets/fonts/Lora-Variable.ttf");
const PAGE_MARGIN = 42;
const BODY_SIZE = 9;
const BODY_LEADING = 12;

const URGENCY_LABEL: Record<Urgency, string> = {
  emergency: "НЕОТЛОЖНО",
  urgent: "СРОЧНО",
  planned: "ПЛАНОВО",
  routine: "РУТИННО",
};

interface PdfBlock {
  heading: string;
  lines: string[];
}

let bodyFontBytesPromise: Promise<Uint8Array> | undefined;
let serifFontBytesPromise: Promise<Uint8Array> | undefined;

function bodyFontBytes(): Promise<Uint8Array> {
  bodyFontBytesPromise ??= readFile(BODY_FONT_PATH).then((bytes) =>
    Uint8Array.from(bytes),
  );
  return bodyFontBytesPromise;
}

function serifFontBytes(): Promise<Uint8Array> {
  serifFontBytesPromise ??= readFile(SERIF_FONT_PATH).then((bytes) =>
    Uint8Array.from(bytes),
  );
  return serifFontBytesPromise;
}

function joined(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "нет данных";
}

function severity(value: number | null): string {
  return value === null ? "—" : `${value}/10`;
}

function verifiedFlags(
  session: ReadonlySession,
  result: TriageResult,
): RedFlag[] {
  return result.red_flags.filter((flag) => {
    if (flag.evidence.trim().length === 0) return false;
    if (flag.evidence_kind === "derived") {
      return flag.source_message_index === -1;
    }
    const source = session.messages[flag.source_message_index];
    return (
      Number.isInteger(flag.source_message_index) &&
      flag.source_message_index >= 0 &&
      source?.role === "user" &&
      source.content.includes(flag.evidence)
    );
  });
}

function sourceDescription(result: TriageResult): string {
  if (result.source === "model") {
    return `обученная модель ${result.model?.model_version ?? "без версии"}`;
  }
  if (result.source === "llm_fallback") {
    if (!result.model) return "обученная модель не запускалась; использована языковая модель";
    return result.model.abstain_reason === "out_of_label_space"
      ? "случай вне обученного набора; использована языковая модель"
      : "обученная модель воздержалась из-за низкой уверенности; использована языковая модель";
  }
  return "структурированные признаки не извлечены; сводка построена по правилам";
}

function summaryBlocks(
  session: ReadonlySession,
  result: TriageResult,
): PdfBlock[] {
  const flags = verifiedFlags(session, result);
  const flagLines = flags.length > 0
    ? flags.flatMap((flag) => {
        if (flag.evidence_kind === "derived") {
          return [`${flag.label}: ${flag.evidence} (вычислено из анамнеза)`];
        }
        const question = flag.elicited_by ? ` Вопрос: «${flag.elicited_by}».` : "";
        return [
          `${flag.label}. Цитата пациента, сообщение #${flag.source_message_index + 1}: «${flag.evidence}».${question}`,
        ];
      })
    : ["Проверяемые красные флаги не выявлены."];

  const modelLines: string[] = [];
  if (result.model?.abstained) {
    const reason = result.model.abstain_reason === "out_of_label_space"
      ? "случай вне обученного пространства"
      : "недостаточная уверенность";
    modelLines.push(`Модель воздержалась: ${reason}. Вклад признаков не показан.`);
  } else if (result.model) {
    const pathologies = result.model.pathologies.slice(0, 3);
    if (pathologies.length > 0) {
      modelLines.push("Варианты модели:");
      modelLines.push(
        ...pathologies.map(
          (item, index) =>
            `${index + 1}. ${item.label_ru} — ${Math.round(item.prob * 100)}%`,
        ),
      );
    }
    const contributions = result.model.top_contributions.filter(
      ({ contribution, label_ru }) => contribution !== 0 && label_ru.trim(),
    );
    if (contributions.length > 0) {
      modelLines.push("Вклад признаков:");
      modelLines.push(
        ...contributions.map(
          ({ contribution, label_ru }) =>
            `${contribution > 0 ? "+" : ""}${contribution.toFixed(2)} — ${label_ru}`,
        ),
      );
    }
  } else {
    modelLines.push("Обученная модель не запускалась.");
  }

  const anamnesis = result.anamnesis;
  return [
    {
      heading: "1. ПРИОРИТЕТ",
      lines: [
        URGENCY_LABEL[result.urgency],
        ...result.urgency_reasons.map((reason) => `• ${reason}`),
      ],
    },
    { heading: "2. КРАСНЫЕ ФЛАГИ", lines: flagLines },
    {
      heading: "3. МАРШРУТИЗАЦИЯ",
      lines: result.source === "model" && result.routing.length > 0
        ? result.routing.slice(0, 3).map(
            ({ specialty, confidence }, index) =>
              `${index + 1}. ${specialty} — ${Math.round(confidence * 100)}%`,
          )
        : result.source === "llm_fallback" && result.routing.length > 0
          ? [
              ...result.routing
                .slice(0, 3)
                .map(({ specialty }, index) => `${index + 1}. ${specialty}`),
              "Ориентировочный маршрут, без числовой оценки",
            ]
          : ["Маршрутизация недоступна."],
    },
    {
      heading: "4. ПРЕДВАРИТЕЛЬНАЯ ГИПОТЕЗА",
      lines: [
        result.hypothesis.text,
        result.source === "model"
          ? `Уверенность: ${Math.round(result.hypothesis.confidence * 100)}%`
          : result.source === "llm_fallback"
            ? "Уверенность: низкая"
            : "Числовая уверенность не рассчитывалась",
        result.hypothesis.disclaimer,
      ],
    },
    { heading: "5. МОДЕЛЬ И ВКЛАД ПРИЗНАКОВ", lines: modelLines },
    {
      heading: "6. АНАМНЕЗ",
      lines: [
        `Жалоба: ${anamnesis.chief_complaint || "не указана"}`,
        `Начало: ${anamnesis.symptom.onset || "не указано"}`,
        `Локализация: ${anamnesis.symptom.location || "не указана"}`,
        `Характер: ${anamnesis.symptom.quality || "не указан"}`,
        `Сила: ${severity(anamnesis.symptom.severity)}`,
        `Модификаторы: ${anamnesis.symptom.modifiers || "не указаны"}`,
        `Сопутствующее: ${joined(anamnesis.symptom.associated)}`,
        `Перенесённое: ${joined(anamnesis.past_history)}`,
        `Хронические состояния: ${joined(anamnesis.chronic)}`,
        `Лекарства: ${joined(anamnesis.medications)}`,
        `Аллергии: ${joined(anamnesis.allergies)}`,
        `Контекст: возраст ${anamnesis.context.age ?? "не указан"}; пол ${anamnesis.context.sex}; беременность ${anamnesis.context.pregnancy}; факторы риска ${joined(anamnesis.context.risk_factors)}`,
      ],
    },
    {
      heading: "7. ПОЛНЫЙ ТРАНСКРИПТ",
      lines: session.messages.length > 0
        ? session.messages.map(
            (message, index) =>
              `${index + 1}. ${message.role === "user" ? "Пациент" : "Ассистент"}: ${message.content}`,
          )
        : ["Транскрипт пуст."],
    },
  ];
}

function cleanText(text: string): string {
  return text
    .replace(/\r\n?/gu, "\n")
    .replace(/\t/gu, "    ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "");
}

function splitWideToken(
  token: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  const parts: string[] = [];
  const widths = new Map<string, number>();
  let part: string[] = [];
  let partWidth = 0;

  for (const character of Array.from(token)) {
    let characterWidth = widths.get(character);
    if (characterWidth === undefined) {
      characterWidth = font.widthOfTextAtSize(character, size);
      widths.set(character, characterWidth);
    }
    if (part.length > 0 && partWidth + characterWidth > maxWidth) {
      parts.push(part.join(""));
      part = [character];
      partWidth = characterWidth;
    } else {
      part.push(character);
      partWidth += characterWidth;
    }
  }
  if (part.length > 0) parts.push(part.join(""));

  return parts.flatMap((candidate) => {
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) return [candidate];

    const characters = Array.from(candidate);
    const fitted: string[] = [];
    let start = 0;
    while (start < characters.length) {
      let low = start + 1;
      let high = characters.length;
      let end = low;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const width = font.widthOfTextAtSize(
          characters.slice(start, middle).join(""),
          size,
        );
        if (width <= maxWidth) {
          end = middle;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      fitted.push(characters.slice(start, end).join(""));
      start = end;
    }
    return fitted;
  });
}

function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  const output: string[] = [];
  for (const paragraph of cleanText(text).split("\n")) {
    if (!paragraph) {
      output.push("");
      continue;
    }
    const tokens = paragraph.split(/\s+/u).flatMap((token) =>
      font.widthOfTextAtSize(token, size) <= maxWidth
        ? [token]
        : splitWideToken(token, font, size, maxWidth),
    );
    let line = "";
    for (const token of tokens) {
      const candidate = line ? `${line} ${token}` : token;
      if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) {
        output.push(line);
        line = token;
      } else {
        line = candidate;
      }
    }
    output.push(line);
  }
  return output;
}

/** Render the clinician summary with an embedded repository TTF font. */
export async function renderSummaryPdf(
  session: ReadonlySession,
  result: TriageResult,
): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  const [bodyFont, serifFont] = await Promise.all([
    document.embedFont(await bodyFontBytes(), { subset: true }),
    document.embedFont(await serifFontBytes(), { subset: true }),
  ]);
  document.setTitle("Demeu — сводка первичного опроса");
  document.setSubject("Предварительная гипотеза, приоритет и маршрутизация для врача");
  document.setProducer("Demeu");

  let page: PDFPage = document.addPage(PageSizes.A4);
  let y = page.getHeight() - PAGE_MARGIN;
  const maxWidth = page.getWidth() - PAGE_MARGIN * 2;

  const newPage = (): void => {
    page = document.addPage(PageSizes.A4);
    y = page.getHeight() - PAGE_MARGIN;
  };
  const draw = (
    text: string,
    options: {
      size?: number;
      leading?: number;
      color?: ReturnType<typeof rgb>;
      font?: PDFFont;
    } = {},
  ): void => {
    const size = options.size ?? BODY_SIZE;
    const leading = options.leading ?? BODY_LEADING;
    const font = options.font ?? bodyFont;
    for (const line of wrapText(text, font, size, maxWidth)) {
      if (y - leading < PAGE_MARGIN) newPage();
      if (line) {
        page.drawText(line, {
          x: PAGE_MARGIN,
          y,
          size,
          font,
          color: options.color ?? rgb(0.12, 0.16, 0.2),
        });
      }
      y -= leading;
    }
  };

  draw("DEMEU — Сводка первичного опроса", {
    size: 16,
    leading: 22,
    color: rgb(0.08, 0.36, 0.31),
    font: serifFont,
  });
  draw(`Сессия: ${session.id}`);
  draw(`Источник: ${sourceDescription(result)}`);
  y -= 6;

  for (const block of summaryBlocks(session, result)) {
    draw(block.heading, {
      size: 11,
      leading: 16,
      color: rgb(0.08, 0.36, 0.31),
    });
    for (const [index, line] of block.lines.entries()) {
      draw(line, {
        font:
          block.heading === "4. ПРЕДВАРИТЕЛЬНАЯ ГИПОТЕЗА" && index === 0
            ? serifFont
            : bodyFont,
      });
    }
    y -= 7;
  }

  return document.save({ useObjectStreams: false });
}
