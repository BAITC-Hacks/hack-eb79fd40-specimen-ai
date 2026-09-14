import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { FileState } from "./storage/file-state";
import { currentWorkspaceActor, workspaceConfigured, WorkspaceAuthError } from "./workspace-auth";
import { workspace } from "./workspace";
import { TelegramClient, TelegramNotifier, splitForTelegram, telegramNotifierFromEnv } from "./telegram";
import { renderPatientMemoPdf, renderPatientMemoText } from "./patient-memo";
import type { AbortedSessionNotice } from "./store";
import type { ReadonlySession, TriageResult } from "./types";
import type { PatientMemo, ReferralActor, ReferralDetail } from "./referrals/types";

type DeliveryStatus = "sending" | "sent" | "failed" | "unknown";
interface DeliveryEntry { identity: string; payloadHash: string; commands: string[]; status: DeliveryStatus }
interface JournalData { schemaVersion: 1; entries: DeliveryEntry[] }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (status: number, code: string): never => { throw new WorkspaceAuthError(status, code); };

function validateJournal(value: unknown): JournalData {
  const document = value as JournalData;
  const hex = (item: unknown) => typeof item === "string" && /^[a-f0-9]{64}$/u.test(item);
  if (!document || Object.keys(document).sort().join(",") !== "entries,schemaVersion" || document.schemaVersion !== 1 || !Array.isArray(document.entries)) throw new Error("Invalid delivery journal");
  const identities = new Set<string>(); const commands = new Set<string>();
  for (const entry of document.entries) {
    if (!entry || Object.keys(entry).sort().join(",") !== "commands,identity,payloadHash,status" || !hex(entry.identity) || !hex(entry.payloadHash) || !Array.isArray(entry.commands) || !entry.commands.length || !["sending", "sent", "failed", "unknown"].includes(entry.status) || identities.has(entry.identity)) throw new Error("Invalid delivery entry");
    for (const command of entry.commands) { if (!hex(command) || commands.has(command)) throw new Error("Invalid delivery command"); commands.add(command); }
    identities.add(entry.identity);
  }
  return document;
}

export class DeliveryJournal {
  private readonly state: FileState<JournalData>;
  constructor(filename: string) {
    this.state = new FileState({ path: filename, initial: () => ({ schemaVersion: 1, entries: [] }), validate: validateJournal });
  }
  async deliver(identity: unknown, command: unknown, payload: unknown, send: () => Promise<void>): Promise<{ sent: true }> {
    const identityHash = hash(identity); const commandHash = hash(command); const payloadHash = hash(payload);
    const replay = await this.state.transaction((draft) => {
      const byCommand = draft.entries.find((entry) => entry.commands.includes(commandHash));
      if (byCommand && (byCommand.identity !== identityHash || byCommand.payloadHash !== payloadHash)) fail(409, "IDEMPOTENCY_CONFLICT");
      const previous = draft.entries.find((entry) => entry.identity === identityHash);
      if (previous) {
        if (previous.payloadHash !== payloadHash) fail(409, "IDEMPOTENCY_CONFLICT");
        if (previous.status !== "sent") fail(409, "DELIVERY_UNCONFIRMED");
        if (!previous.commands.includes(commandHash)) previous.commands.push(commandHash);
        return true;
      }
      draft.entries.push({ identity: identityHash, commands: [commandHash], payloadHash, status: "sending" });
      return false;
    });
    if (replay) return { sent: true };
    try {
      await send();
      await this.state.transaction((draft) => { draft.entries.find((entry) => entry.identity === identityHash)!.status = "sent"; });
      return { sent: true };
    } catch {
      // The remote system may have accepted a message. Never retry automatically,
      // including when recording the final state failed after successful delivery.
      await this.state.transaction((draft) => { draft.entries.find((entry) => entry.identity === identityHash)!.status = "unknown"; }).catch(() => undefined);
      return fail(409, "DELIVERY_UNCONFIRMED");
    }
  }
  close() { return this.state.close(); }
}

interface DeliveryClient {
  sendMessage(chatId: string, text: string): Promise<void>;
  sendDocument(chatId: string, pdf: Uint8Array, filename?: string): Promise<void>;
}
export interface ScopedNotifierDeps {
  ownerForToken: (token: string) => Promise<ReferralActor | null>;
  currentActor: (id: string) => Promise<ReferralActor | null>;
  client: () => DeliveryClient;
  journal: () => DeliveryJournal;
  summaryNotifier?: (chatId: string) => Pick<TelegramNotifier, "sendDoctorSummary" | "sendAbortedNotice">;
  pdf?: (memo: PatientMemo) => Promise<Uint8Array>;
}

export class ScopedWorkspaceNotifier {
  constructor(private readonly deps: ScopedNotifierDeps) {}
  private async recipient(owner: ReferralActor | null, organizationId?: string): Promise<ReferralActor & { telegramChatId: string }> {
    if (!owner || owner.role === "analyst") return fail(503, "DELIVERY_RECIPIENT_UNAVAILABLE");
    const current = await this.deps.currentActor(owner.id);
    if (!current || current.role === "analyst" || current.organizationId !== (organizationId ?? owner.organizationId) || !current.telegramChatId || !/^-?[1-9][0-9]{0,18}$/u.test(current.telegramChatId)) return fail(503, "DELIVERY_RECIPIENT_UNAVAILABLE");
    return { ...current, telegramChatId: current.telegramChatId };
  }
  private notifier(chatId: string) {
    return this.deps.summaryNotifier?.(chatId) ?? new TelegramNotifier(this.deps.client() as TelegramClient, [chatId]);
  }
  async sendDoctorSummary(session: ReadonlySession, result: TriageResult): Promise<void> {
    const recipient = await this.recipient(await this.deps.ownerForToken(session.doctorToken));
    await this.deps.journal().deliver(["completed", session.id], ["completed", session.id], [recipient.id, recipient.organizationId, recipient.telegramChatId, result], () => this.notifier(recipient.telegramChatId).sendDoctorSummary(session, result));
  }
  async sendAbortedNotice(notice: AbortedSessionNotice): Promise<void> {
    const recipient = await this.recipient(await this.deps.ownerForToken(notice.doctorToken));
    await this.deps.journal().deliver(["aborted", notice.sessionId], ["aborted", notice.sessionId], [recipient.id, recipient.organizationId, recipient.telegramChatId, notice], () => this.notifier(recipient.telegramChatId).sendAbortedNotice(notice));
  }
  async sendReferral(actor: ReferralActor, referral: ReferralDetail, memo: PatientMemo, idempotencyKey: string): Promise<{ sent: true }> {
    if (actor.role === "analyst" || actor.organizationId !== referral.organizationId || (actor.role !== "owner" && actor.id !== referral.doctorId)) return fail(403, "FORBIDDEN");
    const currentOwner = await this.deps.currentActor(referral.doctorId);
    const recipient = await this.recipient(currentOwner, referral.organizationId);
    const text = `Направление: ${referral.profile}\nКомплектность: ${{ complete: "комплектен", incomplete: "не комплектен", expired: "есть истёкшие сроки", unknown: "не проверено" }[referral.completeness.status]}\n\n${renderPatientMemoText(memo)}`;
    const pdf = await (this.deps.pdf ?? renderPatientMemoPdf)(memo);
    const client = this.deps.client();
    return this.deps.journal().deliver(["referral", referral.organizationId, referral.id, referral.revision], [actor.organizationId, actor.id, idempotencyKey], [recipient.id, recipient.telegramChatId, text], async () => {
      for (const chunk of splitForTelegram(text)) await client.sendMessage(recipient.telegramChatId, chunk);
      await client.sendDocument(recipient.telegramChatId, pdf, "demeu-patient-memo.pdf");
    });
  }
}

const globals = globalThis as typeof globalThis & { __demeuDeliveryJournal?: { filename: string; journal: DeliveryJournal } };
export function scopedWorkspaceNotifier(): ScopedWorkspaceNotifier {
  return new ScopedWorkspaceNotifier({
    ownerForToken: (token) => workspace().ownerForToken(token), currentActor: currentWorkspaceActor,
    client: () => {
      const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
      if (!token) return fail(503, "DELIVERY_RECIPIENT_UNAVAILABLE");
      return new TelegramClient(token);
    },
    journal: () => {
      if (!process.env.DEMEU_DATA_DIR?.trim()) return fail(503, "WORKSPACE_UNAVAILABLE");
      const filename = resolve(process.env.DEMEU_DATA_DIR, "deliveries.json");
      if (globals.__demeuDeliveryJournal && globals.__demeuDeliveryJournal.filename !== filename) return fail(503, "WORKSPACE_UNAVAILABLE");
      return (globals.__demeuDeliveryJournal ??= { filename, journal: new DeliveryJournal(filename) }).journal;
    },
  });
}

export function workspaceNotifierFromEnv() {
  // Even partial workspace configuration must fail closed, never broadcast.
  return workspaceConfigured() ? scopedWorkspaceNotifier() : telegramNotifierFromEnv();
}
