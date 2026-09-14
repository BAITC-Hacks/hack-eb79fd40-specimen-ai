export class RequestBodyError extends Error {
  constructor(readonly status: 400 | 413) {
    super(status === 413 ? "Request body too large" : "Invalid request body");
  }
}

// Reads a bounded clone so existing handlers can still parse the original body.
export async function readSessionBody(req: Request): Promise<Record<string, unknown>> {
  const reader = req.clone().body?.getReader();
  if (!reader) throw new RequestBodyError(400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) {
        // A tee branch cancellation waits for its sibling. Cancel both without
        // awaiting either here, so an unread original body cannot deadlock 413.
        void reader.cancel().catch(() => undefined);
        void req.body?.cancel().catch(() => undefined);
        throw new RequestBodyError(413);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new RequestBodyError(400);
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof RequestBodyError) throw error;
    throw new RequestBodyError(400);
  } finally {
    reader.releaseLock();
  }
}
