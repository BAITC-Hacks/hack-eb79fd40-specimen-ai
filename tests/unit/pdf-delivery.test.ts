import { describe, expect, it, vi } from "vitest";
import {
  TelegramClient,
  TelegramNotifier,
  type TelegramFetch,
} from "../../lib/telegram";
import { PDF_RESULT, PDF_SESSION } from "../fixtures/pdf";

function successfulFetch(calls: { url: string; init?: RequestInit }[]): TelegramFetch {
  return async (input, init) => {
    calls.push({ url: input.toString(), init });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
}

describe("optional PDF delivery", () => {
  it("sends text first and then the generated PDF document", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const renderPdf = vi.fn(async () => new Uint8Array([37, 80, 68, 70]));
    const notifier = new TelegramNotifier(
      new TelegramClient("bot-token", { fetcher: successfulFetch(calls) }),
      ["1001"],
      renderPdf,
    );

    await notifier.sendDoctorSummary(PDF_SESSION, PDF_RESULT);

    expect(renderPdf).toHaveBeenCalledOnce();
    expect(calls[0].url).toContain("/sendMessage");
    expect(calls.at(-1)?.url).toContain("/sendDocument");
  });

  it("keeps the completed text delivery successful when PDF rendering fails", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const notifier = new TelegramNotifier(
      new TelegramClient("bot-token", { fetcher: successfulFetch(calls) }),
      ["1001"],
      async () => {
        throw new Error("PDF unavailable");
      },
    );

    await expect(
      notifier.sendDoctorSummary(PDF_SESSION, PDF_RESULT),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/sendMessage");
  });

  it("keeps the text delivery successful when sendDocument fails", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher: TelegramFetch = async (input, init) => {
      const url = input.toString();
      calls.push({ url, init });
      return url.endsWith("/sendDocument")
        ? new Response(JSON.stringify({ ok: false }), { status: 500 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const notifier = new TelegramNotifier(
      new TelegramClient("bot-token", { fetcher }),
      ["1001"],
      async () => new Uint8Array([37, 80, 68, 70]),
    );

    await expect(
      notifier.sendDoctorSummary(PDF_SESSION, PDF_RESULT),
    ).resolves.toBeUndefined();
    expect(calls.map(({ url }) => url.split("/").at(-1))).toEqual([
      "sendMessage",
      "sendDocument",
    ]);
  });

  it("does not attach a PDF to the aborted-session notice", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const renderPdf = vi.fn(async () => new Uint8Array([37, 80, 68, 70]));
    const notifier = new TelegramNotifier(
      new TelegramClient("bot-token", { fetcher: successfulFetch(calls) }),
      ["1001"],
      renderPdf,
    );

    await notifier.sendAbortedNotice({
      sessionId: PDF_SESSION.id,
      doctorToken: PDF_SESSION.doctorToken,
      startedAt: PDF_SESSION.createdAt,
      abortedAt: PDF_SESSION.completedAt ?? PDF_SESSION.createdAt,
      reason: "ttl_expired",
    });

    expect(renderPdf).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/sendMessage");
  });
});
