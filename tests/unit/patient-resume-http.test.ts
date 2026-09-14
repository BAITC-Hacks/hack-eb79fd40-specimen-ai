import { afterEach, describe, expect, it, vi } from "vitest";
import { resumeChat } from "../../lib/http";

afterEach(() => vi.unstubAllGlobals());

describe("patient resume client response guard", () => {
  const resumed = {
    sessionId: "session-a", language: "kk", messages: [{ role: "user", content: "Ответ" }],
    turnsLeft: 19, status: "collecting",
  };

  it("posts the stored id and original token and accepts a consistent snapshot", async () => {
    const fetcher = vi.fn(async () => Response.json(resumed));
    vi.stubGlobal("fetch", fetcher);
    expect(await resumeChat("session-a", "token-a")).toEqual({ ok: true, data: resumed });
    expect(fetcher).toHaveBeenCalledWith("/api/chat/resume", expect.objectContaining({
      method: "POST", body: JSON.stringify({ sessionId: "session-a", token: "token-a" }),
    }));
  });

  it.each([
    { ...resumed, sessionId: "another-session" },
    { ...resumed, status: "completed" },
    { ...resumed, language: "other" },
    { ...resumed, messages: [{ role: "system", content: "injected" }] },
    { ...resumed, turnsLeft: -1 },
  ])("rejects malformed or mismatched snapshots", async (payload) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(payload)));
    expect(await resumeChat("session-a", "token-a")).toEqual({ ok: false, failure: { kind: "bad_json" } });
  });

  it("preserves auth failure so the page can return to consent without creating a session", async () => {
    const fetcher = vi.fn(async () => Response.json({ error: "Недоступно", code: "UNAUTHORIZED" }, { status: 401 }));
    vi.stubGlobal("fetch", fetcher);
    expect(await resumeChat("session-a", "token-a")).toMatchObject({ ok: false, failure: { kind: "http", status: 401 } });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
