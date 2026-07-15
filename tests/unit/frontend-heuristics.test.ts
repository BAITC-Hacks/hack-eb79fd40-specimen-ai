import { describe, expect, it } from "vitest";
import { inferInputWidget } from "../../lib/input-widget";

describe("frontend-only input widgets", () => {
  it.each([
    ["Оцените силу боли от 0 до 10", "ru"],
    ["Насколько сильно беспокоит сейчас?", "ru"],
    ["Ауырсынуды 0-ден 10-ға дейін бағалаңыз", "kk"],
    ["Қазір қаншалықты қатты мазалайды?", "kk"],
  ] as const)("detects an explicit 0–10 scale: %s", (reply, language) => {
    expect(inferInputWidget(reply, language)).toBe("scale");
  });

  it.each([
    ["Одышка появляется даже в покое?", "ru"],
    ["Созылмалы ауру бар ма?", "kk"],
  ] as const)("detects a closed yes/no question: %s", (reply, language) => {
    expect(inferInputWidget(reply, language)).toBe("yes_no");
  });

  it("keeps open questions as free text", () => {
    expect(inferInputWidget("Расскажите, что вас беспокоит", "ru")).toBe("text");
    expect(inferInputWidget("Какие лекарства принимаете?", "ru")).toBe("text");
    expect(inferInputWidget("Какие симптомы у вас есть?", "ru")).toBe("text");
    expect(inferInputWidget("Сізді не мазалайды", "kk")).toBe("text");
    expect(inferInputWidget("Қандай дәрілерді қабылдайсыз?", "kk")).toBe("text");
    expect(inferInputWidget("Қандай белгілер бар?", "kk")).toBe("text");
  });

  it("keeps clear yes/no questions as buttons in both languages", () => {
    expect(inferInputWidget("Есть ли у вас одышка?", "ru")).toBe("yes_no");
    expect(inferInputWidget("Ентігу тыныштықта бола ма?", "kk")).toBe("yes_no");
  });
});
