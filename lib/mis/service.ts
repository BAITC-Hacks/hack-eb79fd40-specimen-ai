import { randomUUID } from "node:crypto";
import type { Referral, ReferralRepository } from "../referrals/types";
import { misFail } from "./errors";
import { projectResearchRisk, reconcileReadiness, reconcileResearchRisk } from "./projection";
import { MIS_RESEARCH_SCOPE, type MisDeliveryEnvelope, type MisPrincipal, type MisRiskEvaluation, type MisRiskPort } from "./types";

const LEASE_MS = 5 * 60 * 1000;
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

export interface MisServiceOptions {
  now?: () => number;
  id?: () => string;
  risk: MisRiskPort;
  researchEventsEnabled: boolean;
}

export class MisService {
  private readonly now: () => number;
  private readonly id: () => string;
  constructor(private readonly repository: ReferralRepository, private readonly options: MisServiceOptions) {
    this.now = options.now ?? Date.now;
    this.id = options.id ?? randomUUID;
  }

  private async currentRisk(referrals: readonly Referral[]): Promise<Map<string, MisRiskEvaluation>> {
    const values = await Promise.all(referrals.map(async (referral) => {
      if (!referral.registrationSnapshot) return [referral.id, {
        status: "unavailable", researchOnly: true, reason: "INPUTS_INCOMPLETE",
      } satisfies MisRiskEvaluation] as const;
      try { return [referral.id, await this.options.risk.evaluate(referral.registrationSnapshot)] as const; }
      catch { return [referral.id, { status: "unavailable", researchOnly: true,
        reason: "ARTIFACT_UNAVAILABLE" } satisfies MisRiskEvaluation] as const; }
    }));
    return new Map(values);
  }

  async pull(principal: MisPrincipal, limit: number): Promise<{ events: MisDeliveryEnvelope[]; retryAfterMs: number }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return misFail(400, "BAD_REQUEST");
    const researchScoped = principal.scopes.includes(MIS_RESEARCH_SCOPE);
    const researchEnabled = this.options.researchEventsEnabled;
    const candidates = researchScoped && researchEnabled ? await this.repository.read((state) => {
      const riskIds = new Set((state.misOutbox ?? []).filter((event) => event.organizationId === principal.organizationId
        && event.type === "referral.research_risk.changed").map((event) => event.referralId));
      return state.referrals.filter((referral) => referral.organizationId === principal.organizationId && riskIds.has(referral.id));
    }) : [];
    const risks = researchScoped && researchEnabled ? await this.currentRisk(candidates) : new Map<string, MisRiskEvaluation>();
    const now = this.now();
    return this.repository.transaction((state) => {
      const outbox = state.misOutbox ??= [];
      for (const referral of state.referrals.filter((entry) => entry.organizationId === principal.organizationId)) {
        const priorReadiness = outbox.some((event) => event.referralId === referral.id && event.type === "referral.readiness.changed");
        if (priorReadiness) reconcileReadiness(state, referral, now, this.id);
        const priorRisk = outbox.some((event) => event.referralId === referral.id && event.type === "referral.research_risk.changed");
        if (priorRisk && researchScoped && !researchEnabled) reconcileResearchRisk(state, referral, null, false, now, this.id);
        if (priorRisk && researchScoped && researchEnabled && risks.has(referral.id)) {
          reconcileResearchRisk(state, referral, risks.get(referral.id)!, true, now, this.id);
        }
      }

      const accessible = (event: { type: string }) => event.type !== "referral.research_risk.changed" || researchScoped;
      const deliverable = outbox.filter((event) => event.organizationId === principal.organizationId && accessible(event)
        && (event.status === "pending" || event.status === "leased" && event.leaseUntil !== null && event.leaseUntil <= now))
        .filter((event) => !outbox.some((earlier) => earlier.referralId === event.referralId && earlier.sequence < event.sequence
          && accessible(earlier)
          && (earlier.status === "pending" || earlier.status === "leased")))
        .sort((left, right) => left.occurredAt - right.occurredAt || left.sequence - right.sequence)
        .slice(0, limit);
      const events = deliverable.map((event): MisDeliveryEnvelope => {
        event.status = "leased";
        event.deliveryAttempt += 1;
        event.deliveryId = this.id();
        event.leasedByIntegrationId = principal.integrationId;
        event.leasedAt = now;
        event.leaseUntil = now + LEASE_MS;
        return {
          eventId: event.eventId,
          sequence: event.sequence,
          deliveryId: event.deliveryId,
          deliveryAttempt: event.deliveryAttempt,
          type: event.type,
          schemaVersion: 1,
          occurredAt: event.occurredAt,
          subject: { referralId: event.referralId, revision: event.referralRevision },
          data: structuredClone(event.data),
        };
      });
      return { events, retryAfterMs: LEASE_MS };
    });
  }

  async ack(principal: MisPrincipal, eventId: string, input: { deliveryId: string; idempotencyKey: string }) {
    if (!/^[A-Za-z0-9_-]{1,200}$/u.test(eventId) || !input || !/^[A-Za-z0-9_-]{1,200}$/u.test(input.deliveryId)
      || !/^[A-Za-z0-9_-]{8,128}$/u.test(input.idempotencyKey)) return misFail(400, "BAD_REQUEST");
    const payload = canonical({ eventId, deliveryId: input.deliveryId });
    return this.repository.transaction((state) => {
      const event = (state.misOutbox ?? []).find((candidate) => candidate.eventId === eventId
        && candidate.organizationId === principal.organizationId);
      if (!event) return misFail(404, "NOT_FOUND");
      if (event.type === "referral.research_risk.changed" && !principal.scopes.includes(MIS_RESEARCH_SCOPE)) {
        return misFail(404, "NOT_FOUND");
      }
      const existing = (state.misCommands ??= []).find((command) => command.integrationId === principal.integrationId
        && command.organizationId === principal.organizationId && command.key === input.idempotencyKey);
      if (existing) {
        if (existing.payload !== payload) return misFail(409, "IDEMPOTENCY_CONFLICT");
        return { ...JSON.parse(existing.response) as { eventId: string; acked: boolean; ackedAt: number }, replayed: true };
      }
      if (event.status === "acked" && event.ackedDeliveryId === input.deliveryId) {
        const response = { eventId, acked: true, ackedAt: event.ackedAt! };
        state.misCommands.push({ integrationId: principal.integrationId, organizationId: principal.organizationId,
          key: input.idempotencyKey, payload, eventId, response: JSON.stringify(response), recordedAt: this.now() });
        return { ...response, replayed: true };
      }
      const now = this.now();
      if (event.status !== "leased" || event.deliveryId !== input.deliveryId
        || event.leasedByIntegrationId !== principal.integrationId || event.leaseUntil === null || event.leaseUntil <= now) {
        return misFail(409, "DELIVERY_STALE");
      }
      event.status = "acked";
      event.ackedAt = now;
      event.ackedDeliveryId = input.deliveryId;
      event.ackedByIntegrationId = principal.integrationId;
      const response = { eventId, acked: true, ackedAt: now };
      state.misCommands.push({ integrationId: principal.integrationId, organizationId: principal.organizationId,
        key: input.idempotencyKey, payload, eventId, response: JSON.stringify(response), recordedAt: now });
      return { ...response, replayed: false };
    });
  }
}

export function riskProjectionForTesting(referral: Referral, evaluation: MisRiskEvaluation | null, enabled: boolean, now: number) {
  return projectResearchRisk(referral, evaluation, enabled, now);
}
