import { readSessionBody, RequestBodyError } from "./request-body";

interface Coordinator {
  gate: Promise<unknown>;
  active: Set<Promise<unknown>>;
  tails: Map<string, Promise<unknown>>;
}

const globals = globalThis as typeof globalThis & { __demeuSessionOperations?: Coordinator };
const state = (globals.__demeuSessionOperations ??= {
  gate: Promise.resolve(), active: new Set(), tails: new Map(),
});
const settled = (promise: Promise<unknown>): Promise<unknown> => promise.catch(() => undefined);

// Only public orchestration enters this queue; internal finalize must not reenter.
export function withSessionOperation<T>(id: string, work: () => Promise<T>): Promise<T> {
  const gate = state.gate;
  const previous = state.tails.get(id) ?? Promise.resolve();
  const operation = Promise.all([settled(gate), settled(previous)]).then(work);
  state.active.add(operation);
  state.tails.set(id, operation);
  const release = () => {
    state.active.delete(operation);
    if (state.tails.get(id) === operation) state.tails.delete(id);
  };
  void operation.then(release, release);
  return operation;
}

export function withSessionSweep<T>(work: () => Promise<T>): Promise<T> {
  // Capture old operations before publishing the barrier. New operations wait
  // for the sweep, while the sweep waits only for operations registered earlier.
  const previousGate = state.gate;
  const previousOperations = [...state.active];
  const sweep = Promise.all([previousGate, ...previousOperations].map(settled)).then(work);
  state.gate = settled(sweep);
  return sweep;
}

export async function withSessionRequest(req: Request, work: () => Promise<Response>): Promise<Response> {
  let id: unknown;
  try {
    id = (await readSessionBody(req)).sessionId;
  } catch (error) {
    if (error instanceof RequestBodyError && error.status === 413) {
      return Response.json({ error: "Запрос недоступен", code: "BODY_TOO_LARGE" }, {
        status: 413, headers: { "Cache-Control": "no-store" },
      });
    }
    return work(); // Existing handler owns invalid-body responses.
  }
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id)) {
    return work();
  }
  return withSessionOperation(id, work);
}
