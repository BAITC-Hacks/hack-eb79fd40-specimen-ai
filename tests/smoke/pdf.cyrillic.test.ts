import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { PDFFont } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import { renderSummaryPdf } from "../../lib/pdf";
import { ABSTAIN_HYPOTHESIS } from "../../lib/clinical-copy";
import { PDF_RESULT, PDF_SESSION } from "../fixtures/pdf";

const OUTPUT_PATH = "/tmp/demeu-summary-test.pdf";
const KAZAKH_SAMPLE = "Әә Ғғ Ққ Ңң Өө Ұұ Үү Һһ Іі";

describe("PDF Cyrillic smoke", () => {
  it("bundles the two runtime PDF families and their OFL records", () => {
    const expected = new Map([
      [
        "assets/fonts/Lora-Variable.ttf",
        "822a6621ccbe8d97d20ac88c1c41f5615c9c2c202eaa75f272cd452aac6475a7",
      ],
      [
        "assets/fonts/IBMPlexSans-Variable.ttf",
        "3b031aa4216174205bd8471f88a49b91f093169e9e87bd5262242bc5967fe2e3",
      ],
    ]);
    const provenance = readFileSync("assets/fonts/README.md", "utf8");
    for (const [path, expectedDigest] of expected) {
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path).byteLength).toBeGreaterThan(200_000);
      const digest = createHash("sha256")
        .update(readFileSync(path))
        .digest("hex");
      expect(digest).toBe(expectedDigest);
      expect(provenance).toContain(digest);
    }
    for (const path of [
      "assets/fonts/LICENSE-Lora-OFL.txt",
      "assets/fonts/LICENSE-IBM-Plex-Sans-OFL.txt",
    ]) {
      expect(readFileSync(path, "utf8")).toContain(
        "SIL OPEN FONT LICENSE Version 1.1",
      );
    }
  });

  it("creates a non-empty PDF with an embedded TrueType font", async () => {
    const session = {
      ...structuredClone(PDF_SESSION),
      messages: [
        ...structuredClone(PDF_SESSION.messages),
        { role: "user" as const, content: KAZAKH_SAMPLE },
      ],
    };
    const bytes = await renderSummaryPdf(session, PDF_RESULT);
    await writeFile(OUTPUT_PATH, bytes);

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    expect(bytes.byteLength).toBeGreaterThan(20_000);
    const raw = Buffer.from(bytes).toString("latin1");
    expect(raw).toContain("/FontFile2");
    expect(raw).not.toContain("/WinAnsiEncoding");
    const fonts = spawnSync("pdffonts", [OUTPUT_PATH], { encoding: "utf8" });
    expect(fonts.status).toBe(0);
    expect(fonts.stdout).toContain("Lora-Regular");
    expect(fonts.stdout).toContain("IBMPlexSans-Regular");
    expect(fonts.stdout).toMatch(/CID TrueType\s+Identity-H\s+yes\s+no\s+yes/gu);
  });

  it("is extractable as readable Russian text with the full transcript", () => {
    expect(existsSync(OUTPUT_PATH)).toBe(true);
    const extracted = spawnSync("pdftotext", [OUTPUT_PATH, "-"], {
      encoding: "utf8",
    });

    expect(extracted.error).toBeUndefined();
    expect(extracted.status).toBe(0);
    expect(extracted.stdout).toMatch(/гипотеза/iu);
    expect(extracted.stdout).toContain("У меня давит в груди *_[]<>& и тяжело дышать");
    expect(extracted.stdout).toContain("Как давно это началось?");
    expect(extracted.stdout).toContain(KAZAKH_SAMPLE);
    expect(extracted.stdout).toMatch(/не диагноз/iu);
    expect(extracted.stdout).toContain("+2.41 — давящая боль за грудиной");
    expect(extracted.stdout).toContain("-0.35 — боль усиливается на вдохе");
  });

  it("renders a minimal summary without inventing missing content", async () => {
    const session = {
      ...structuredClone(PDF_SESSION),
      messages: [],
      turnCount: 0,
    };
    const result = structuredClone(PDF_RESULT);
    result.anamnesis.chief_complaint = "";
    result.anamnesis.symptom.onset = "";
    result.anamnesis.symptom.location = "";
    result.anamnesis.symptom.quality = "";
    result.anamnesis.symptom.severity = null;
    result.anamnesis.symptom.modifiers = "";
    result.anamnesis.symptom.associated = [];
    result.anamnesis.past_history = [];
    result.anamnesis.chronic = [];
    result.anamnesis.allergies = [];
    result.anamnesis.medications = [];
    result.anamnesis.context.risk_factors = [];
    result.red_flags = [];
    result.urgency_reasons = [];
    result.routing = [];
    result.source = "rules_only";
    result.hypothesis.confidence = 0;
    delete result.model;

    const path = "/tmp/demeu-summary-minimal.pdf";
    await writeFile(path, await renderSummaryPdf(session, result));
    const extracted = spawnSync("pdftotext", [path, "-"], {
      encoding: "utf8",
    });

    expect(extracted.status).toBe(0);
    expect(extracted.stdout).toContain("Проверяемые красные флаги не выявлены.");
    expect(extracted.stdout).toContain("Маршрутизация недоступна.");
    expect(extracted.stdout).toContain("Жалоба: не указана");
    expect(extracted.stdout).toContain("Сила: —");
    expect(extracted.stdout).not.toContain("Сила: 0/10");
    expect(extracted.stdout).toContain("Транскрипт пуст.");
    expect(extracted.stdout).toMatch(/не диагноз/iu);
  });

  it("preserves an explicit zero intensity in the PDF", async () => {
    const result = structuredClone(PDF_RESULT);
    result.anamnesis.symptom.severity = 0;
    const path = "/tmp/demeu-summary-zero-severity.pdf";
    await writeFile(path, await renderSummaryPdf(PDF_SESSION, result));
    const extracted = spawnSync("pdftotext", [path, "-"], {
      encoding: "utf8",
    });

    expect(extracted.status).toBe(0);
    expect(extracted.stdout).toContain("Сила: 0/10");
  });

  it.each(["llm_fallback", "rules_only"] as const)(
    "renders extractable Russian text for the %s path",
    async (source) => {
      const result = structuredClone(PDF_RESULT);
      result.source = source;
      result.hypothesis.confidence = source === "rules_only" ? 0 : 0.35;
      if (source === "rules_only") {
        delete result.model;
      } else {
        result.model = {
          pathologies: [],
          top_contributions: [],
          abstained: true,
          abstain_reason: "out_of_label_space",
          model_version: "test-lr-v1",
        };
      }

      const path = `/tmp/demeu-summary-${source}.pdf`;
      await writeFile(path, await renderSummaryPdf(PDF_SESSION, result));
      const extracted = spawnSync("pdftotext", [path, "-"], {
        encoding: "utf8",
      });

      expect(extracted.status).toBe(0);
      expect(extracted.stdout).toContain(
        source === "llm_fallback"
          ? "ГИПОТЕЗА НЕ СФОРМИРОВАНА"
          : "ПРЕДВАРИТЕЛЬНАЯ ГИПОТЕЗА",
      );
      expect(extracted.stdout).toMatch(/не диагноз/iu);
      expect(extracted.stdout).toContain("ПОЛНЫЙ ТРАНСКРИПТ");
      expect(extracted.stdout).toContain("Два часа назад, боль восемь из десяти.");
      if (source === "rules_only") {
        expect(extracted.stdout).toContain("Обученная модель не запускалась.");
        expect(extracted.stdout).not.toContain("Варианты модели:");
        expect(extracted.stdout).toContain("Маршрутизация недоступна.");
      } else {
        expect(extracted.stdout).toContain(ABSTAIN_HYPOTHESIS);
        expect(extracted.stdout).not.toMatch(/уверенн/iu);
        expect(extracted.stdout).toContain("Модель воздержалась:");
        expect(extracted.stdout).not.toContain("Варианты модели:");
        expect(extracted.stdout).toContain(
          "Ориентировочный маршрут, без числовой оценки",
        );
        expect(extracted.stdout).not.toContain("кардиология — 72%");
        expect(extracted.stdout).not.toContain("кардиология — 0%");
      }
    },
  );

  it("does not present malformed or unverifiable evidence as a patient quote", async () => {
    const result = structuredClone(PDF_RESULT);
    result.red_flags = [
      {
        code: "invalid",
        label: "Непроверяемый флаг",
        evidence: "этого нет в сообщении",
        evidence_kind: "quote",
        emergency: true,
        source_message_index: 1,
      },
      {
        code: "empty",
        label: "Пустая цитата",
        evidence: "",
        evidence_kind: "quote",
        emergency: true,
        source_message_index: 1,
      },
    ];
    const path = "/tmp/demeu-summary-invalid-evidence.pdf";
    await writeFile(path, await renderSummaryPdf(PDF_SESSION, result));
    const extracted = spawnSync("pdftotext", [path, "-"], {
      encoding: "utf8",
    });

    expect(extracted.status).toBe(0);
    expect(extracted.stdout).not.toContain("Непроверяемый флаг");
    expect(extracted.stdout).not.toContain("Пустая цитата");
    expect(extracted.stdout).toContain("Проверяемые красные флаги не выявлены.");
  });

  it("paginates a long transcript without dropping its final message", async () => {
    const session = {
      ...structuredClone(PDF_SESSION),
      messages: Array.from({ length: 120 }, (_, index) => ({
        role: index % 2 === 0 ? ("assistant" as const) : ("user" as const),
        content:
          index === 119
            ? "Финальная реплика пациента сохранена полностью."
            : `Реплика ${index + 1}: подробный русский текст для проверки переноса между страницами.`,
      })),
    };
    const path = "/tmp/demeu-summary-long-transcript.pdf";
    await writeFile(path, await renderSummaryPdf(session, PDF_RESULT));

    const extracted = spawnSync("pdftotext", [path, "-"], { encoding: "utf8" });
    expect(extracted.status).toBe(0);
    expect(extracted.stdout).toContain(
      "Финальная реплика пациента сохранена полностью.",
    );
    expect((extracted.stdout.match(/\f/gu) ?? []).length).toBeGreaterThan(1);
  });

  it("wraps an oversized unbroken token without page overflow or tail loss", async () => {
    const widthSpy = vi.spyOn(PDFFont.prototype, "widthOfTextAtSize");
    let widthCalls = 0;
    const tail = "КОНЕЦ ДЛИННОЙ РЕПЛИКИ СОХРАНЁН";
    const oversizedToken = "сверхдлинноеслово".repeat(1200);
    const session = {
      ...structuredClone(PDF_SESSION),
      messages: [
        {
          role: "user" as const,
          content: `${oversizedToken} ${tail}`,
        },
      ],
    };
    const path = "/tmp/demeu-summary-wide-token.pdf";
    try {
      await writeFile(path, await renderSummaryPdf(session, PDF_RESULT));
    } finally {
      widthCalls = widthSpy.mock.calls.length;
      widthSpy.mockRestore();
    }
    const extracted = spawnSync("pdftotext", [path, "-"], {
      encoding: "utf8",
    });
    const info = spawnSync("pdfinfo", [path], { encoding: "utf8" });
    const boxed = spawnSync("pdftotext", ["-bbox", path, "-"], {
      encoding: "utf8",
    });

    expect(extracted.status).toBe(0);
    expect(extracted.stdout).toMatch(
      /КОНЕЦ\s+ДЛИННОЙ\s+РЕПЛИКИ\s+СОХРАНЁН/u,
    );
    expect([...oversizedToken]).toHaveLength(20_400);
    expect(extracted.stdout.replace(/\s/gu, "")).toContain(oversizedToken);
    expect(info.status).toBe(0);
    const pages = /Pages:\s+(\d+)/u.exec(info.stdout)?.[1];
    expect(Number(pages)).toBeGreaterThan(1);
    expect(Number(pages)).toBeLessThanOrEqual(10);
    expect(boxed.status).toBe(0);
    const rightEdges = [...boxed.stdout.matchAll(/xMax="([0-9.]+)"/gu)].map(
      (match) => Number(match[1]),
    );
    expect(rightEdges.length).toBeGreaterThan(0);
    expect(Math.max(...rightEdges)).toBeLessThanOrEqual(554);
    expect(widthCalls).toBeLessThan(1_000);
  });

  it("makes progress through combining marks, surrogate pairs, and Kazakh tokens", async () => {
    const tail = "ЮНИКОД ХВОСТ СОХРАНЁН";
    const session = {
      ...structuredClone(PDF_SESSION),
      messages: [
        {
          role: "user" as const,
          content: `${"а\u0301".repeat(4_000)} ${"😀".repeat(2_000)} ${"Қазақша".repeat(1_000)} ${tail}`,
        },
      ],
    };
    const path = "/tmp/demeu-summary-unicode-wide-token.pdf";
    await writeFile(path, await renderSummaryPdf(session, PDF_RESULT));
    const extracted = spawnSync("pdftotext", [path, "-"], {
      encoding: "utf8",
    });
    const info = spawnSync("pdfinfo", [path], { encoding: "utf8" });
    const boxed = spawnSync("pdftotext", ["-bbox", path, "-"], {
      encoding: "utf8",
    });

    expect(extracted.status).toBe(0);
    expect(extracted.stdout).toMatch(/ЮНИКОД\s+ХВОСТ\s+СОХРАНЁН/u);
    expect(extracted.stdout).toContain("Қазақша");
    expect(info.status).toBe(0);
    expect(boxed.status).toBe(0);
    const pages = Number(/Pages:\s+(\d+)/u.exec(info.stdout)?.[1]);
    expect(pages).toBeGreaterThan(1);
    expect(pages).toBeLessThanOrEqual(10);
    const rightEdges = [...boxed.stdout.matchAll(/xMax="([0-9.]+)"/gu)].map(
      (match) => Number(match[1]),
    );
    expect(Math.max(...rightEdges)).toBeLessThanOrEqual(554);
  });
});
