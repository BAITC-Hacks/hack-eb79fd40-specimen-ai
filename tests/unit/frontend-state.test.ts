import { describe, expect, it } from "vitest";
import {
  isSessionCompleted,
  isSessionMissing,
  isStartInvalid,
  patientFailureText,
} from "../../lib/patient-state";
import { PATIENT } from "../../lib/i18n";

describe("patient error routing", () => {
  it("treats only canonical token errors as an invalid link", () => {
    expect(isStartInvalid({ kind: "http", status: 404, code: "TOKEN_NOT_FOUND" })).toBe(true);
    expect(isStartInvalid({ kind: "http", status: 400, code: "TOKEN_REQUIRED" })).toBe(true);
    expect(isStartInvalid({ kind: "http", status: 404, code: "SESSION_NOT_FOUND" })).toBe(false);
    expect(isStartInvalid({ kind: "http", status: 400, code: "BAD_REQUEST" })).toBe(false);
  });

  it("replays only canonical completed sessions and keeps replay failures visible", () => {
    expect(isSessionCompleted({ kind: "http", status: 409, code: "SESSION_COMPLETED" })).toBe(true);
    expect(isSessionCompleted({ kind: "http", status: 409, code: "SESSION_ABORTED" })).toBe(false);
    expect(isSessionMissing({ kind: "http", status: 404, code: "SESSION_NOT_FOUND" })).toBe(true);
    expect(patientFailureText({ kind: "http", status: 500 }, "ru")).toBe(PATIENT.ru.serviceError);
    expect(patientFailureText({ kind: "network" }, "kk")).toBe(PATIENT.kk.networkError);
  });
});
