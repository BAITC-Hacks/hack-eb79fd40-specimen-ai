import { describe, expect, it } from "vitest";
import { readSessionBody } from "../../lib/request-body";
import { withSessionRequest } from "../../lib/session-operations";

describe("bounded patient request body", () => {
  it("preserves the original request for the existing handler", async () => {
    const req = new Request("http://localhost/api/chat", { method: "POST", body: '{"sessionId":"one"}' });
    expect(await readSessionBody(req)).toEqual({ sessionId: "one" });
    expect(await req.json()).toEqual({ sessionId: "one" });
  });

  it("accepts exactly 16 KiB and counts UTF-8 bytes", async () => {
    const prefix = '{"message":"';
    const suffix = '"}';
    const content = "я".repeat((16_384 - prefix.length - suffix.length) / 2);
    const req = new Request("http://localhost/api/chat", { method: "POST", body: prefix + content + suffix });
    expect((await readSessionBody(req)).message).toBe(content);
  });

  it("rejects a chunked oversized body without waiting for the tee sibling or reaching the handler", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"message":"'));
        controller.enqueue(new Uint8Array(16_384));
        // Deliberately leave the stream open: cancellation must not wait for EOF.
      },
    });
    const req = new Request("http://localhost/api/chat", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    let called = false;
    const response = await withSessionRequest(req, async () => { called = true; return Response.json({}); });
    expect(response.status).toBe(413);
    expect(called).toBe(false);
  }, 1_000);
});
