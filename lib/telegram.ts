import type {
  AbortedNoticePort,
  AbortedSessionNotice,
} from "./store";
import { renderSummaryPdf } from "./pdf";
import {
  displayedHypothesis,
  hypothesisHeading,
  processingModeNotice,
} from "./clinical-copy";
import { normalizeAnamnesis, type ReadonlySession, type TriageResult, type Urgency } from "./types";

export const TELEGRAM_MESSAGE_LIMIT = 4096;
const DEFAULT_TIMEOUT_MS = 10_000;

export type TelegramFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type PdfRenderer = (
  session: ReadonlySession,
  result: TriageResult,
) => Promise<Uint8Array>;

export interface DoctorSummaryContext {
  doctorDisplayName: string;
  episodeLabel: string;
  intakeUrl: string;
}

export class TelegramDeliveryError extends Error {
  constructor(
    message: string,
    readonly kind: "api" | "network" | "timeout",
  ) {
    super(message);
    this.name = "TelegramDeliveryError";
  }
}

export class TelegramBroadcastError extends Error {
  constructor(
    readonly delivery: "completed" | "aborted",
    readonly failedRecipientCount: number,
  ) {
    super(
      `Telegram ${delivery} broadcast mandatory text delivery failed for ${failedRecipientCount} recipient(s)`,
    );
    this.name = "TelegramBroadcastError";
  }
}

interface TelegramClientOptions {
  fetcher?: TelegramFetch;
  timeoutMs?: number;
}

interface TelegramApiResponse {
  ok?: boolean;
}

export class TelegramClient {
  private readonly fetcher: TelegramFetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly token: string,
    options: TelegramClientOptions = {},
  ) {
    if (!token.trim()) throw new Error("TELEGRAM_BOT_TOKEN is required");
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (text.length > TELEGRAM_MESSAGE_LIMIT) {
      throw new Error("Telegram message exceeds 4096 characters");
    }
    await this.request("sendMessage", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  }

  async sendDocument(
    chatId: string,
    pdf: Uint8Array,
    filename = "demeu-summary.pdf",
  ): Promise<void> {
    const form = new FormData();
    form.set("chat_id", chatId);
    form.set(
      "document",
      new Blob([Uint8Array.from(pdf).buffer], { type: "application/pdf" }),
      filename,
    );
    await this.request("sendDocument", { body: form });
  }

  private async request(
    method: "sendMessage" | "sendDocument",
    init: RequestInit,
  ): Promise<void> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(
        `https://api.telegram.org/bot${this.token}/${method}`,
        { method: "POST", ...init, signal },
      );
    } catch {
      if (signal.aborted) {
        throw new TelegramDeliveryError(
          `Telegram ${method} timed out`,
          "timeout",
        );
      }
      throw new TelegramDeliveryError(
        `Telegram ${method} network request failed`,
        "network",
      );
    }

    const payload = (await response
      .json()
      .catch(() => ({}))) as TelegramApiResponse;
    if (!response.ok || payload.ok !== true) {
      throw new TelegramDeliveryError(
        `Telegram ${method} failed with HTTP ${response.status}`,
        "api",
      );
    }
  }
}

const URGENCY: Record<Urgency, { emoji: string; label: string }> = {
  emergency: { emoji: "🔴", label: "НЕОТЛОЖНО" },
  urgent: { emoji: "🟠", label: "СРОЧНО" },
  planned: { emoji: "🟡", label: "ПЛАНОВО" },
  routine: { emoji: "🟢", label: "РУТИННО" },
};

const DATE_TIME = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Asia/Almaty",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function value(value: string): string {
  return value.trim() || "не указано";
}

function list(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "нет данных";
}

function line(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function historyList(values: readonly string[], status: "reported" | "denied" | "not_stated"): string {
  if (values.length > 0) return list(values);
  return status === "denied" ? "отрицает" : "не уточнено";
}

function severity(value: number | null): string {
  return value === null ? "—" : `${value}/10`;
}

function sourceLine(result: TriageResult): string {
  if (result.processing_mode === "deterministic") {
    return "ИСТОЧНИК: детерминированный опросник и правила безопасности";
  }
  if (result.source === "model") {
    return `ИСТОЧНИК: модель ${result.model?.model_version ?? "не указана"}`;
  }
  if (result.source === "llm_fallback") {
    if (!result.model) {
      return "ИСТОЧНИК: обученная модель не запускалась → гипотеза сформулирована языковой моделью";
    }
    const reason = result.model?.abstain_reason;
    return reason === "out_of_label_space"
      ? "ИСТОЧНИК: случай вне обученного набора состояний → гипотеза не сформирована"
      : "ИСТОЧНИК: модель воздержалась от ранжирования → гипотеза не сформирована";
  }
  return "ИСТОЧНИК: признаки не извлечены → сводка построена только на правилах и репликах пациента";
}

function renderFlags(
  session: ReadonlySession,
  result: TriageResult,
): string[] {
  if (result.red_flags.length === 0) return ["Не выявлено."];

  const rendered = result.red_flags.flatMap((flag) => {
    if (flag.evidence.trim().length === 0) return [];
    const title = `${flag.emergency ? "🚨" : "•"} ${flag.label} [${flag.code}]`;
    if (flag.evidence_kind === "derived") {
      return [
        title,
        `  Основание (вычислено из анамнеза): ${flag.evidence}`,
      ];
    }
    const source = session.messages[flag.source_message_index];
    if (
      !Number.isInteger(flag.source_message_index) ||
      flag.source_message_index < 0 ||
      source?.role !== "user" ||
      !source.content.includes(flag.evidence)
    ) {
      return [];
    }
    const number = flag.source_message_index + 1;
    if (flag.elicited_by) {
      return [
        title,
        `  Вопрос: «${flag.elicited_by}»`,
        `  Ответ пациента (сообщение #${number}): «${flag.evidence}»`,
      ];
    }
    return [
      title,
      `  Цитата пациента (сообщение #${number}): «${flag.evidence}»`,
    ];
  });

  return rendered.length > 0 ? rendered : ["Не выявлено."];
}

function renderHypothesis(result: TriageResult): string[] {
  if (result.processing_mode === "deterministic" || result.model?.abstained) {
    return [
      hypothesisHeading(result).toUpperCase(),
      displayedHypothesis(result),
      `⚠️ ${result.hypothesis.disclaimer}`,
    ];
  }
  let confidence = "";
  if (result.source === "model") {
    confidence = ` · уверенность ${Math.round(result.hypothesis.confidence * 100)}%`;
  }
  return [
    `ПРЕДВАРИТЕЛЬНАЯ ГИПОТЕЗА${confidence}`,
    displayedHypothesis(result),
    `⚠️ ${result.hypothesis.disclaimer}`,
  ];
}

function renderModelDetails(result: TriageResult): string[] {
  if (!result.model || result.model.abstained) return [];

  const pathologies = result.model.pathologies.slice(0, 3).map(
    (pathology, index) =>
      `${index + 1}. ${pathology.label_ru} — ${Math.round(pathology.prob * 100)}%`,
  );
  const contributions = result.model.top_contributions
    .filter(({ contribution, label_ru }) => contribution !== 0 && label_ru.trim())
    .map(
      ({ contribution, label_ru }) =>
        `${contribution > 0 ? "+" : ""}${contribution.toFixed(2)} ${label_ru}`,
    );

  return [
    ...(pathologies.length > 0
      ? ["ВАРИАНТЫ МОДЕЛИ", ...pathologies]
      : []),
    ...(contributions.length > 0
      ? ["ВКЛАД ПРИЗНАКОВ", ...contributions]
      : []),
  ];
}

function renderAbstain(result: TriageResult): string[] {
  if (!result.model?.abstained) return [];
  const reason =
    result.model.abstain_reason === "out_of_label_space"
      ? "случай вне обученного пространства модели"
      : "порог надёжности модели не пройден";
  return [
    "МОДЕЛЬ ВОЗДЕРЖАЛАСЬ",
    `Причина: ${reason}. Вклад признаков не показан.`,
  ];
}

export function renderSummary(
  session: ReadonlySession,
  result: TriageResult,
  context?: DoctorSummaryContext,
): string {
  const urgency = URGENCY[result.urgency];
  const finishedAt = session.completedAt ?? Date.now();
  const duration = Math.max(
    0,
    Math.round((finishedAt - session.createdAt) / 60_000),
  );
  const sex = { m: "м", f: "ж", unknown: "не указан" }[
    result.anamnesis.context.sex
  ];
  const age = result.anamnesis.context.age ?? "не указан";
  const routing =
    result.source === "model" && result.routing.length > 0
      ? result.routing
          .slice(0, 3)
          .map(
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
        : ["Недоступна."];
  const reasons =
    result.urgency_reasons.length > 0
      ? result.urgency_reasons.map((reason) => `• ${reason}`)
      : ["• Дополнительные причины не указаны"];
  const anamnesis = normalizeAnamnesis(result.anamnesis);
  const episode = line(context?.episodeLabel ?? "Новый завершённый опрос") || "Новый завершённый опрос";
  const doctor = context ? line(context.doctorDisplayName) : "";
  const intakeUrl = context ? line(context.intakeUrl) : "";

  const sections: string[][] = [
    [
      `${urgency.emoji} ${urgency.label} — Demeu, сводка первичного опроса`,
      `Эпизод: ${episode}${doctor ? ` · Врач: ${doctor}` : ""}`,
      `${DATE_TIME.format(finishedAt)} · длительность ${duration} мин`,
      `ПАЦИЕНТ: ${sex}, ${age} лет`,
      `ЖАЛОБА: ${value(anamnesis.chief_complaint)}`,
    ],
    ["КРАСНЫЕ ФЛАГИ", ...renderFlags(session, result)],
    ["ПОЧЕМУ ТАКОЙ ПРИОРИТЕТ", ...reasons],
    ["МАРШРУТИЗАЦИЯ", ...routing],
    ...(() => {
      const abstain = renderAbstain(result);
      return abstain.length > 0 ? [abstain] : [];
    })(),
    renderHypothesis(result),
    ...(() => {
      const model = renderModelDetails(result);
      return model.length > 0 ? [model] : [];
    })(),
    [
      "АНАМНЕЗ",
      `Начало: ${value(anamnesis.symptom.onset)} · локализация: ${value(anamnesis.symptom.location)}`,
      `Характер: ${value(anamnesis.symptom.quality)} · сила: ${severity(anamnesis.symptom.severity)}`,
      `Сопутствующее: ${list(anamnesis.symptom.associated)}`,
      `Перенесённое: ${historyList(anamnesis.past_history, anamnesis.history_status.past_history)}`,
      `Хронические: ${historyList(anamnesis.chronic, anamnesis.history_status.chronic)} · лекарства: ${historyList(anamnesis.medications, anamnesis.history_status.medications)} · аллергии: ${historyList(anamnesis.allergies, anamnesis.history_status.allergies)}`,
      ...(anamnesis.negative_findings.length > 0 ? [`Явно отрицает: ${anamnesis.negative_findings.join(", ")}`] : []),
    ],
    [sourceLine(result)],
    [processingModeNotice(result.processing_mode)],
    ...(intakeUrl ? [["Открыть сводку в Demeu:", intakeUrl]] : []),
  ];

  return sections.map((section) => section.join("\n")).join("\n\n");
}

export function splitForTelegram(
  text: string,
  limit = TELEGRAM_MESSAGE_LIMIT,
): string[] {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Telegram chunk limit must be a positive integer");
  }
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    let cut = limit;
    for (const separator of ["\n\n", "\n", " "]) {
      const candidate = remaining.lastIndexOf(separator, limit - separator.length);
      if (candidate >= Math.floor(limit / 2)) {
        cut = candidate + separator.length;
        break;
      }
    }
    const lastCode = remaining.charCodeAt(cut - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) cut -= 1;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining.length > 0 || chunks.length === 0) chunks.push(remaining);
  return chunks;
}

export function splitForTelegramWithDisclaimer(
  text: string,
  disclaimer: string,
  limit = TELEGRAM_MESSAGE_LIMIT,
  finalLink?: string,
): string[] {
  const normalizedDisclaimer = disclaimer.trim();
  if (!normalizedDisclaimer) {
    throw new Error("Telegram summary disclaimer is required");
  }
  const disclaimerLine = `⚠️ ${normalizedDisclaimer}`;
  const footer = `\n\n${disclaimerLine}`;
  const normalizedLink = finalLink?.trim() ?? "";
  const finalFooter = `${footer}${normalizedLink ? `\n\nОткрыть сводку в Demeu:\n${normalizedLink}` : ""}`;
  if (finalFooter.length >= limit) {
    throw new Error("Telegram summary disclaimer leaves no room for content");
  }

  const lines = text.split("\n");
  if (normalizedLink && lines.at(-1)?.trim() === normalizedLink) {
    lines.pop();
    if (lines.at(-1)?.trim() === "Открыть сводку в Demeu:") lines.pop();
  }
  const body = lines
    .filter((line) => line.trim() !== disclaimerLine)
    .join("\n")
    .trimEnd();
  const chunks = splitForTelegram(body, limit - finalFooter.length);
  return chunks.map((chunk, index) => `${chunk.trimEnd()}${index === chunks.length - 1 ? finalFooter : footer}`);
}

export async function sendDoctorSummary(
  client: TelegramClient,
  chatId: string,
  session: ReadonlySession,
  result: TriageResult,
  pdf?: Uint8Array,
  context?: DoctorSummaryContext,
): Promise<void> {
  const intakeUrl = context ? line(context.intakeUrl) : undefined;
  for (const chunk of splitForTelegramWithDisclaimer(
    renderSummary(session, result, context),
    result.hypothesis.disclaimer,
    TELEGRAM_MESSAGE_LIMIT,
    intakeUrl,
  )) {
    await client.sendMessage(chatId, chunk);
  }
  if (pdf) await client.sendDocument(chatId, pdf);
}

export function renderAbortedNotice(notice: AbortedSessionNotice): string {
  return [
    "⚠️ Demeu: пациент начал опрос и не закончил.",
    `Сессия: ${notice.sessionId}`,
    `Токен врача: ${notice.doctorToken}`,
    `Начало: ${DATE_TIME.format(notice.startedAt)}`,
    `Завершение: ${DATE_TIME.format(notice.abortedAt)}`,
    `Причина: ${notice.reason}`,
  ].join("\n");
}

export async function sendAbortedNotice(
  client: TelegramClient,
  chatId: string,
  notice: AbortedSessionNotice,
): Promise<void> {
  await client.sendMessage(chatId, renderAbortedNotice(notice));
}

const MIN_TELEGRAM_CHAT_ID = -(2n ** 63n);
const MAX_TELEGRAM_CHAT_ID = 2n ** 63n - 1n;

function assertTelegramChatId(value: string): void {
  if (!/^-?[1-9]\d*$/.test(value)) {
    throw new Error("Telegram doctor chat IDs must be non-zero integers");
  }
  const parsed = BigInt(value);
  if (parsed < MIN_TELEGRAM_CHAT_ID || parsed > MAX_TELEGRAM_CHAT_ID) {
    throw new Error("Telegram doctor chat IDs must fit signed 64-bit integers");
  }
}

function normalizeTelegramChatIds(values: readonly string[]): readonly string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    assertTelegramChatId(value);
    if (!seen.has(value)) {
      seen.add(value);
      unique.push(value);
    }
  }
  if (unique.length === 0) {
    throw new Error("At least one Telegram doctor chat ID is required");
  }
  return Object.freeze(unique);
}

export function parseTelegramDoctorChatIds(
  plural: string | undefined,
  legacy: string | undefined,
): readonly string[] {
  if (plural?.trim()) {
    return normalizeTelegramChatIds(plural.split(","));
  }
  if (legacy?.trim()) {
    return normalizeTelegramChatIds([legacy]);
  }
  return [];
}

export class TelegramNotifier implements AbortedNoticePort {
  private readonly chatIds: readonly string[];

  constructor(
    private readonly client: TelegramClient,
    chatIds: readonly string[],
    private readonly pdfRenderer: PdfRenderer = renderSummaryPdf,
  ) {
    this.chatIds = normalizeTelegramChatIds(chatIds);
  }

  async sendDoctorSummary(
    session: ReadonlySession,
    result: TriageResult,
    pdf?: Uint8Array,
    context?: DoctorSummaryContext,
  ): Promise<void> {
    const intakeUrl = context ? line(context.intakeUrl) : undefined;
    const chunks = splitForTelegramWithDisclaimer(
      renderSummary(session, result, context),
      result.hypothesis.disclaimer,
      TELEGRAM_MESSAGE_LIMIT,
      intakeUrl,
    );
    let document = pdf;
    if (!document) {
      try {
        document = await this.pdfRenderer(session, result);
      } catch {
        console.error("Telegram PDF rendering failed");
      }
    }

    let failedRecipientCount = 0;
    for (const chatId of this.chatIds) {
      let recipientTextFailed = false;
      for (const chunk of chunks) {
        try {
          await this.client.sendMessage(chatId, chunk);
        } catch {
          recipientTextFailed = true;
          console.error("Telegram completed text chunk delivery failed");
        }
      }
      if (recipientTextFailed) {
        failedRecipientCount += 1;
      }

      if (document) {
        try {
          await this.client.sendDocument(chatId, document);
        } catch {
          console.error("Telegram PDF delivery failed");
        }
      }
    }

    if (failedRecipientCount > 0) {
      throw new TelegramBroadcastError("completed", failedRecipientCount);
    }
  }

  async sendAbortedNotice(notice: AbortedSessionNotice): Promise<void> {
    const text = renderAbortedNotice(notice);
    let failedRecipientCount = 0;
    for (const chatId of this.chatIds) {
      try {
        await this.client.sendMessage(chatId, text);
      } catch {
        failedRecipientCount += 1;
        console.error("Telegram aborted text delivery failed");
      }
    }
    if (failedRecipientCount > 0) {
      throw new TelegramBroadcastError("aborted", failedRecipientCount);
    }
  }
}

export function telegramNotifierFromEnv(): TelegramNotifier | undefined {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return undefined;
  const chatIds = parseTelegramDoctorChatIds(
    process.env.TELEGRAM_DOCTOR_CHAT_IDS,
    process.env.TELEGRAM_DOCTOR_CHAT_ID,
  );
  if (chatIds.length === 0) return undefined;
  return new TelegramNotifier(new TelegramClient(token), chatIds);
}
