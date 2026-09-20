import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../app/workspace/referrals/[id]/page.tsx", import.meta.url), "utf8");

// Static guardrails complement the browser route-switch/interleaved-response tests.
describe("referral detail record boundary", () => {
  it("remounts local forms and memo state for a new route identity", () => {
    expect(source).toContain("<ReferralRecord key={id} id={id} />");
    expect(source).not.toContain("useWorkspaceAuth");
  });
  it("requires both loaded identity and returned record identity before content or commands", () => {
    expect(source).toContain("loadedId === id && referral?.id === id && !loading");
    expect(source).toContain('actor.role !== "analyst" && ready && referral && facts');
    expect(source).toContain("if (disabled || activeOperation.current) return null");
    expect(source).toContain("if (value.referral.id !== id) throw");
    expect(source).toContain("if (result.referral.id !== id) throw");
  });
  it("invalidates pending responses when the loaded record leaves", () => {
    expect(source).toContain("return () => { active = false; generation.current = requestGeneration + 1; }");
    expect(source.match(/const requestGeneration = beginOperation\(\)/g)).toHaveLength(3);
    expect(source.match(/finally \{ finishOperation\(requestGeneration\); \}/g)).toHaveLength(3);
    expect(source).toContain("if (requestGeneration !== generation.current) return");
  });
  it("blocks stale revisions and retains entered intent without automatic replay", () => {
    expect(source).toContain("!ready || busy || conflict");
    expect(source).toContain("setConflict(true); setRetainedIntent(intent)");
    expect(source).toContain("Изменение не применяется автоматически.");
    expect(source.match(/<fieldset disabled=\{disabled\}>/g)).toHaveLength(2);
    expect(source).toContain("useWorkspaceCommand()");
  });
  it("hides PDF navigation while actions are blocked and keeps notification explicit", () => {
    expect(source).toContain('{disabled ? <button className="btn subtle" disabled>');
    expect(source).toContain("onClick={() => void notify()}");
    expect(source).toContain("if (requestGeneration === generation.current) setMemo(result.memo)");
  });
  it("surfaces triage urgency, reasons, routing and source without unsupported percentages", () => {
    expect(source).toContain('referral.triageSnapshot?.urgency === "emergency"');
    expect(source).toContain("referral.triageSnapshot.urgency_reasons.map");
    expect(source).toContain("referral.triageSnapshot.routing.map((route) => route.specialty)");
    expect(source).toContain("SOURCE_LABELS[referral.triageSnapshot.source]");
    expect(source).toContain("referral.triageSnapshot.hypothesis.disclaimer");
    expect(source).not.toContain(".confidence");
  });
  it("gates exam editing and focuses its first field respecting reduced motion", () => {
    expect(source).toContain('disabled={disabled} onClick={() => { setDateError(""); setEditingExam({ ...exam }); }}');
    expect(source).toContain('input[name="label"]');
    expect(source).toContain("focus({ preventScroll: true })");
    expect(source).toContain("prefers-reduced-motion: reduce");
  });
});
