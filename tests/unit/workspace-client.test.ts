import { afterEach, describe, expect, it, vi } from "vitest";
import { advanceWorkspaceAuthEpoch, workspaceRequest } from "../../app/workspace/client";

afterEach(() => { vi.unstubAllGlobals(); });

describe("workspace request authentication epoch", () => {
  it.each([401, 403])("ignores a previous principal's delayed %s without swallowing its error", async (status) => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    let respond!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { respond = resolve; })));
    const pending = workspaceRequest("/api/referrals");
    const rejected = expect(pending).rejects.toMatchObject({ status });
    advanceWorkspaceAuthEpoch(); // Synchronous logout: old requests become obsolete.
    advanceWorkspaceAuthEpoch(); // Successful login of the next principal.
    respond(Response.json({ code: "UNAUTHORIZED" }, { status }));
    await rejected;
    expect(dispatchEvent).not.toHaveBeenCalled();
  });
  it.each([[401, "demeu:workspace-expired"], [403, "demeu:workspace-forbidden"]] as const)("invalidates the current principal on %s", async (status, event) => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({}, { status })));
    await expect(workspaceRequest("/api/referrals")).rejects.toMatchObject({ status });
    expect(dispatchEvent).toHaveBeenCalledOnce();
    expect(dispatchEvent.mock.calls[0][0].type).toBe(event);
  });
  it("does not broadcast rejected login credentials", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({}, { status: 401 })));
    await expect(workspaceRequest("/api/workspace/auth", { id: "synthetic", password: "synthetic" })).rejects.toMatchObject({ status: 401, message: "Неверный логин или пароль." });
    expect(dispatchEvent).not.toHaveBeenCalled();
  });
});
