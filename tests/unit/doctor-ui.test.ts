import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildPatientLink,
  decodePatientToken,
  isDoctorUnauthorized,
} from "@/lib/doctor-ui";

function roundTrip(token: string): string | null {
  const link = buildPatientLink("https://demeu.test", token);
  const routeParam = new URL(link).pathname.slice("/c/".length);
  return decodePatientToken(() => decodeURIComponent(routeParam));
}

describe("doctor UI boundary helpers", () => {
  it("encodes an opaque token as exactly one URL segment", () => {
    expect(buildPatientLink("https://demeu.test", "opaque/value")).toBe(
      "https://demeu.test/c/opaque%2Fvalue",
    );
  });

  it("restores the original opaque token before POST /api/chat/start", () => {
    const original = "opaque/value";
    expect(roundTrip(original)).toBe(original);

    const patientPage = readFileSync(
      `${process.cwd()}/app/c/[token]/page.tsx`,
      "utf8",
    );
    expect(patientPage).toMatch(
      /const\s+token\s*=\s*decodeURIComponent\(params\.token\)/,
    );
  });

  it("decodes one time only and preserves literal escapes and Unicode", () => {
    expect(roundTrip("%2F")).toBe("%2F");
    expect(roundTrip("қазақ тілі")).toBe("қазақ тілі");
    expect(roundTrip("0123456789abcdef")).toBe("0123456789abcdef");
  });

  it("fails closed when a route segment has malformed percent-encoding", () => {
    let calls = 0;
    expect(
      decodePatientToken(() => {
        calls += 1;
        return decodeURIComponent("%E0%A4%A");
      }),
    ).toBeNull();
    expect(calls).toBe(1);
  });

  it("recognizes only the contractual authorization failure", () => {
    expect(
      isDoctorUnauthorized({
        kind: "http",
        status: 401,
        code: "UNAUTHORIZED",
      }),
    ).toBe(true);
    expect(
      isDoctorUnauthorized({ kind: "http", status: 401, code: "OTHER" }),
    ).toBe(false);
    expect(isDoctorUnauthorized({ kind: "http", status: 401 })).toBe(false);
    expect(
      isDoctorUnauthorized({
        kind: "http",
        status: 403,
        code: "UNAUTHORIZED",
      }),
    ).toBe(false);
  });
});
