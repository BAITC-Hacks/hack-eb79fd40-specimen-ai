import type {
  AbortedNoticePort,
  AbortedSessionNotice,
} from "./store";
import { renderSummaryPdf } from "./pdf";
import type { ReadonlySession, TriageResult, Urgency } from "./types";

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

export class TelegramDeliveryError extends Error {
  constructor(
    message: string,
    readonly kind: "api" | "network" | "timeout",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TelegramDeliveryError";
  }
}

interface TelegramClientOptions {
  fetcher?: TelegramFetch;
  timeoutMs?: number;
}

interface TelegramApiResponse {
  ok?: boolean;
  description?: string;
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
    } catch (error) {
      if (signal.aborted) {
        throw new TelegramDeliveryError(
          `Telegram ${method} timed out`,
          "timeout",
          { cause: error },
        );
      }
      throw new TelegramDeliveryError(
        `Telegram ${method} network request failed`,
        "network",
        { cause: error },
      );
    }

    const payload = (await response
      .json()
      .catch(() => ({}))) as TelegramApiResponse;
    if (!response.ok || payload.ok !== true) {
      const detail = payload.description
        ? `: ${payload.description}`
        : "";
      throw new TelegramDeliveryError(
        `Telegram ${method} failed with HTTP ${response.status}${detail}`,
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

function sourceLine(result: TriageResult): string {
  if (result.source === "model") {
    return `ИСТОЧНИК: модель ${result.model?.model_version ?? "не указана"}`;
  }
  if (result.source === "llm_fallback") {
    if (!result.model) {
      return "ИСТОЧНИК: обученная модель не запускалась → гипотеза сформулирована языковой моделью";
    }
    const reason = result.model?.abstain_reason;
    return reason === "out_of_label_space"
      ? "ИСТОЧНИК: случай вне обученного набора состояний → гипотеза сформулирована языковой моделью"
      : "ИСТОЧНИК: модель не уверена → гипотеза сформулирована языковой моделью";
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
  let confidence = "";
  if (result.source === "model") {
    confidence = ` · уверенность ${Math.round(result.hypothesis.confidence * 100)}%`;
  } else if (result.source === "llm_fallback") {
    confidence = " · уверенность низкая";
  }
  return [
    `ПРЕДВАРИТЕЛЬНАЯ ГИПОТЕЗА${confidence}`,
    result.hypothesis.text,
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
      : "ни один вариант не набрал достаточной уверенности";
  return [
    "МОДЕЛЬ ВОЗДЕРЖАЛАСЬ",
    `Причина: ${reason}. Вклад признаков не показан.`,
  ];
}

export function renderSummary(
  session: ReadonlySession,
  result: TriageResult,
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
    result.routing.length > 0
      ? result.routing
          .slice(0, 3)
          .map(
            ({ specialty, confidence }, index) =>
              `${index + 1}. ${specialty} — ${Math.round(confidence * 100)}%`,
          )
      : ["Недоступна."];
  const reasons =
    result.urgency_reasons.length > 0
      ? result.urgency_reasons.map((reason) => `• ${reason}`)
      : ["• Дополнительные причины не указаны"];
  const anamnesis = result.anamnesis;

  const sections: string[][] = [
    [
      `${urgency.emoji} ${urgency.label} — Demeu, сводка первичного опроса`,
      `Сессия ${session.id} · ${DATE_TIME.format(finishedAt)} · длительность ${duration} мин`,
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
      `Характер: ${value(anamnesis.symptom.quality)} · сила: ${anamnesis.symptom.severity}/10`,
      `Сопутствующее: ${list(anamnesis.symptom.associated)}`,
      `Хронические: ${list(anamnesis.chronic)} · лекарства: ${list(anamnesis.medications)} · аллергии: ${list(anamnesis.allergies)}`,
    ],
    [sourceLine(result)],
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

export async function sendDoctorSummary(
  client: TelegramClient,
  chatId: string,
  session: ReadonlySession,
  result: TriageResult,
  pdf?: Uint8Array,
): Promise<void> {
  for (const chunk of splitForTelegram(renderSummary(session, result))) {
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

export class TelegramNotifier implements AbortedNoticePort {
  constructor(
    private readonly client: TelegramClient,
    private readonly chatId: string,
    private readonly pdfRenderer: PdfRenderer = renderSummaryPdf,
  ) {
    if (!chatId.trim()) throw new Error("TELEGRAM_DOCTOR_CHAT_ID is required");
  }

  async sendDoctorSummary(
    session: ReadonlySession,
    result: TriageResult,
    pdf?: Uint8Array,
  ): Promise<void> {
    await sendDoctorSummary(this.client, this.chatId, session, result);

    let document = pdf;
    if (!document) {
      try {
        document = await this.pdfRenderer(session, result);
      } catch {
        return;
      }
    }

    try {
      await this.client.sendDocument(this.chatId, document);
    } catch {
      // PDF is optional: the complete plain-text summary has already arrived.
    }
  }

  sendAbortedNotice(notice: AbortedSessionNotice): Promise<void> {
    return sendAbortedNotice(this.client, this.chatId, notice);
  }
}

export function telegramNotifierFromEnv(): TelegramNotifier | undefined {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_DOCTOR_CHAT_ID?.trim();
  if (!token || !chatId) return undefined;
  return new TelegramNotifier(new TelegramClient(token), chatId);
}
