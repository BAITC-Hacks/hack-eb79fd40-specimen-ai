import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { linkClientKey, type LinkRateLimiter } from "@/lib/rate-limit";
import type { SessionStore } from "@/lib/store";

interface LinkDeps {
  sessionStore: Pick<SessionStore, "createDoctorToken">;
  limiter: Pick<LinkRateLimiter, "consume">;
  accessCode?: string;
}

export async function handleLink(req: Request, deps: LinkDeps) {
  try {
    const retryAfterMs = deps.limiter.consume(linkClientKey(req.headers));
    if (retryAfterMs > 0) {
      return NextResponse.json(
        {
          error: "Слишком много запросов",
          code: "RATE_LIMITED",
          retry_after_ms: retryAfterMs,
        },
        {
          status: 429,
          headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1_000)) },
        },
      );
    }

    if (deps.accessCode) {
      const expected = Buffer.from(deps.accessCode);
      const supplied = Buffer.from(req.headers.get("x-doctor-code") ?? "");
      if (
        expected.length !== supplied.length ||
        !timingSafeEqual(expected, supplied)
      ) {
        return NextResponse.json(
          { error: "Требуется код доступа врача", code: "UNAUTHORIZED" },
          { status: 401 },
        );
      }
    }

    const token = await deps.sessionStore.createDoctorToken();
    return NextResponse.json({ token });
  } catch {
    return NextResponse.json(
      { error: "Не удалось создать ссылку", code: "INTERNAL" },
      { status: 500 },
    );
  }
}
