import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import type { NextRequest } from "next/server";
import { buildHealthResponse, type HealthResponse } from "./health";

export const DEEP_HEALTH_PROOF_HEADER = "x-demeu-health-proof";
export const DEEP_HEALTH_PROOF_CONTEXT = "demeu-health-extract:v1:";

type HealthEnv = Readonly<Record<string, string | undefined>>;
type Probe = () => Promise<boolean>;

export type ExtractorLoader = () => Promise<
  Pick<typeof import("./extract"), "extractAll">
>;

export interface HealthHandlerResult {
  status: 200 | 404;
  body: HealthResponse;
}

export interface DeepHealthDependencies {
  env?: HealthEnv;
  probeOnce?: Probe;
}

export function computeDeepHealthProof(key: string, commit: string): string {
  return createHmac("sha256", key)
    .update(`${DEEP_HEALTH_PROOF_CONTEXT}${commit}`)
    .digest("hex");
}

function constantTimeProofMatches(provided: string | null, expected: string): boolean {
  const providedDigest = createHash("sha256").update(provided ?? "").digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  const matches = timingSafeEqual(providedDigest, expectedDigest);
  return provided !== null && matches;
}

function isDirectLoopbackRequest(request: NextRequest): boolean {
  if (
    request.headers.has("forwarded") ||
    request.headers.has("x-forwarded-for") ||
    request.headers.has("x-forwarded-host") ||
    request.headers.has("x-forwarded-proto")
  ) {
    return false;
  }
  return ["127.0.0.1", "localhost", "::1"].includes(request.nextUrl.hostname);
}

export function createExtractionProbe(
  loadExtractor: ExtractorLoader = () => import("./extract"),
): Probe {
  return async () => {
    const { extractAll } = await loadExtractor();
    let attempts = 0;
    const result = await extractAll(
      [
        {
          role: "assistant",
          content: "Опишите основную жалобу и когда она началась.",
        },
        {
          role: "user",
          content:
            "Второй день болит горло, температура 38, больно глотать. Боли в груди, одышки и крови нет. Сила боли 5 из 10.",
        },
      ],
      {
        applicationMaxRetries: 0,
        log: () => undefined,
        warn: () => undefined,
        onAttempt(operation) {
          if (operation !== "structured" || attempts >= 1) {
            throw new Error("deep extraction probe exceeded its one-call budget");
          }
          attempts += 1;
        },
      },
    );
    return (
      attempts === 1 &&
      result.extraction_ok &&
      result.anamnesis.chief_complaint.trim().length > 0
    );
  };
}

export function createCachedExtractionProbe(run: Probe = createExtractionProbe()): Probe {
  let cached: Promise<boolean> | undefined;
  return () => {
    cached ??= Promise.resolve()
      .then(run)
      .then((ok) => ok === true)
      .catch(() => false);
    return cached;
  };
}

const productionProbeOnce = createCachedExtractionProbe();

function deepResponse(env: HealthEnv, llm_ok: boolean): HealthResponse {
  return { ...buildHealthResponse(env), llm_ok };
}

export async function handleHealthRequest(
  request: NextRequest,
  deps: DeepHealthDependencies = {},
): Promise<HealthHandlerResult> {
  const env = deps.env ?? process.env;
  if (request.nextUrl.searchParams.get("probe") !== "extract") {
    return { status: 200, body: buildHealthResponse(env) };
  }

  const key = env.ANTHROPIC_API_KEY;
  const commit = env.COMMIT_SHA ?? "unknown";
  if (!key || !isDirectLoopbackRequest(request)) {
    return { status: 404, body: deepResponse(env, false) };
  }

  const expected = computeDeepHealthProof(key, commit);
  if (!constantTimeProofMatches(request.headers.get(DEEP_HEALTH_PROOF_HEADER), expected)) {
    return { status: 404, body: deepResponse(env, false) };
  }

  return {
    status: 200,
    body: deepResponse(env, await (deps.probeOnce ?? productionProbeOnce)()),
  };
}
