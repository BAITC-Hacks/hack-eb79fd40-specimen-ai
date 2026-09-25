import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const detail = readFileSync(new URL("../../app/workspace/intakes/[id]/page.tsx", import.meta.url), "utf8");
const shell = readFileSync(new URL("../../app/workspace/shell.tsx", import.meta.url), "utf8");

describe("intake detail navigation boundary", () => {
  it("loads one encoded intake through its dedicated scoped endpoint", () => {
    expect(detail).toContain("useParams<{ id: string }>()");
    expect(detail).toContain("`/api/workspace/intakes/${encodeURIComponent(id)}`");
    expect(detail).toContain("resource.data?.intake");
    expect(detail).not.toContain("/api/workspace/intakes\"");
  });

  it("keeps referral navigation server-derived and the session identifier out of headings", () => {
    expect(detail).toContain("intake.referralId");
    expect(detail).toContain("encodeURIComponent(intake.referralId)");
    expect(detail).toContain("encodeURIComponent(intake.sessionId)");
    expect(detail).not.toContain("{id}</");
    expect(detail).not.toMatch(/title=\{?id\}?/u);
  });

  it("uses the existing in-place login shell so a requested detail URL survives login", () => {
    expect(shell).toContain("const pathname = usePathname()");
    expect(shell).toContain("if (!auth?.actor) return");
    expect(shell).toContain("setAuth({ actor: result.actor, enabled: true })");
    expect(shell).not.toMatch(/router\.(?:push|replace)\([^)]*workspace/u);
  });
});
