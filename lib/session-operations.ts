import { randomUUID } from "node:crypto";
import { readSessionBody, RequestBodyError } from "./request-body";

interface Coordinator {
  tails: Map<string, Promise<unknown>>;
  idempotency: Map<string, IdempotencyEntry>;
}

interface ResponseSnapshot {
  body: Uint8Array;
  headers: [string, string][];
  status: number;
  statusText: string;
}

interface IdempotencyEntry {
  fingerprint: string;
  createdAt: number;
  outcome: Promise<ResponseSnapshot>;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._~-]{16,128}$/u;
const MAX_IDEMPOTENCY_ENTRIES = 4_096;

const globals = globalThis as typeof globalThis & { __demeuSessionOperations?: Coordinator };
const state = (globals.__demeuSessionOperations ??= {
  tails: new Map(), idempotency: new Map(),
});
const settled = (promise: Promise<unknown>): Promise<unknown> => promise.catch(() => undefined);

// Only public orchestration enters this queue; internal finalize must not reenter.
export function withSessionOperation<T>(id: string, work: () => Promise<T>): Promise<T> {
  const previous = state.tails.get(id) ?? Promise.resolve();
  const operation = settled(previous).then(work);
  state.tails.set(id, operation);
  const release = () => {
    if (state.tails.get(id) === operation) state.tails.delete(id);
  };
  void operation.then(release, release);
  return operation;
}

export function withSessionSweep<T>(work: () => Promise<T>): Promise<T> {
  // Store implementations serialize their own mutations. A process-wide
  // barrier here lets one slow model call block every unrelated patient.
  return work();
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().filter((key) => key !== "requestId")
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function snapshot(response: Response): Promise<ResponseSnapshot> {
  return {
    body: new Uint8Array(await response.arrayBuffer()),
    headers: [...response.headers.entries()],
    status: response.status,
    statusText: response.statusText,
  };
}

function restore(value: ResponseSnapshot): Response {
  return new Response(value.body.slice(), {
    headers: value.headers,
    status: value.status,
    statusText: value.statusText,
  });
}

function trimIdempotencyCache(): void {
  while (state.idempotency.size > MAX_IDEMPOTENCY_ENTRIES) {
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of state.idempotency) {
      if (entry.createdAt < oldestAt) {
        oldestKey = key;
        oldestAt = entry.createdAt;
      }
    }
    if (oldestKey === undefined) return;
    state.idempotency.delete(oldestKey);
  }
}

function conflictResponse(): Response {
  return Response.json({
    error: "Ключ повтора уже использован для другого запроса",
    code: "IDEMPOTENCY_CONFLICT",
    request_id: randomUUID(),
  }, { status: 409, headers: { "Cache-Control": "no-store" } });
}

function idempotentSessionOperation(
  sessionId: string,
  requestId: string,
  input: Record<string, unknown>,
  work: () => Promise<Response>,
): Promise<Response> {
  const key = `${sessionId}\0${requestId}`;
  const fingerprint = canonical(input);
  const existing = state.idempotency.get(key);
  if (existing) {
    return existing.fingerprint === fingerprint
      ? existing.outcome.then(restore)
      : Promise.resolve(conflictResponse());
  }

  const outcome = withSessionOperation(sessionId, async () => snapshot(await work()));
  const entry: IdempotencyEntry = {
    fingerprint,
    createdAt: Date.now(),
    outcome,
  };
  state.idempotency.set(key, entry);
  trimIdempotencyCache();
  void outcome.then(
    (result) => {
      // Only successful mutations are replayed. A failed attempt remains
      // retryable with the same key.
      if (result.status < 200 || result.status >= 300) {
        if (state.idempotency.get(key) === entry) state.idempotency.delete(key);
      }
    },
    () => {
      if (state.idempotency.get(key) === entry) state.idempotency.delete(key);
    },
  );
  return outcome.then(restore);
}

export async function withSessionRequest(req: Request, work: () => Promise<Response>): Promise<Response> {
  let input: Record<string, unknown>;
  try {
    input = await readSessionBody(req);
  } catch (error) {
    if (error instanceof RequestBodyError && error.status === 413) {
      return Response.json({ error: "Запрос недоступен", code: "BODY_TOO_LARGE" }, {
        status: 413, headers: { "Cache-Control": "no-store" },
      });
    }
    return work(); // Existing handler owns invalid-body responses.
  }
  const id = input.sessionId;
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id)) {
    return work();
  }
  if (input.requestId !== undefined) {
    if (typeof input.requestId !== "string" || !IDEMPOTENCY_KEY.test(input.requestId)) {
      return Response.json({ error: "Некорректный ключ повтора", code: "BAD_REQUEST", request_id: randomUUID() }, {
        status: 400, headers: { "Cache-Control": "no-store" },
      });
    }
    return idempotentSessionOperation(id, input.requestId, input, work);
  }
  return withSessionOperation(id, work);
}
