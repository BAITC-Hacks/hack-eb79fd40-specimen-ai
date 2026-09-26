import { describe, expect, it, vi } from "vitest";

import { handleLink } from "../../app/api/link/handler";
import { LinkRateLimiter } from "../../lib/rate-limit";

function linkRequest(): Request {
  return new Request("http://localhost/api/link", {
    method: "POST",
    headers: { "x-forwarded-for": "192.0.2.42" },
  });
}

describe("POST /api/link cost control", () => {
  it("admits ten requests, then returns 429 with retry metadata without creating another token", async () => {
    const createDoctorToken = vi.fn(async () => "0123456789abcdef");
    const deps = {
      sessionStore: { createDoctorToken },
      limiter: new LinkRateLimiter(() => 1_000),
    };

    for (let requestNumber = 1; requestNumber <= 10; requestNumber += 1) {
      const response = await handleLink(linkRequest(), deps);
      expect(response.status).toBe(200);
    }

    const limited = await handleLink(linkRequest(), deps);

    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("6");
    await expect(limited.json()).resolves.toEqual({
      error: "Слишком много запросов",
      code: "RATE_LIMITED",
      retry_after_ms: 6_000,
    });
    expect(createDoctorToken).toHaveBeenCalledTimes(10);
  });
});
