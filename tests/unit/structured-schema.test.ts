import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { EXTRACT_SCHEMA } from "../../lib/extract";
import { structured } from "../../lib/llm";
import { assertSupportedStructuredSchema } from "../../lib/structured-schema";

describe("raw structured-output schema dialect", () => {
  it.each(["minimum", "maximum", "minLength", "maxLength"])(
    "rejects nested unsupported keyword %s recursively",
    (keyword) => {
      const schema = {
        type: "object",
        properties: {
          nested: {
            anyOf: [
              { type: "null" },
              { type: "string", [keyword]: 1 },
            ],
          },
        },
      };
      expect(() => assertSupportedStructuredSchema(schema)).toThrow(keyword);
    },
  );

  it("accepts the supported nullable and required dialect", () => {
    expect(() => assertSupportedStructuredSchema({
      type: "object",
      additionalProperties: false,
      required: ["severity"],
      properties: { severity: { type: ["integer", "null"] } },
    })).not.toThrow();
    expect(() => assertSupportedStructuredSchema(EXTRACT_SCHEMA)).not.toThrow();
  });

  it("blocks an unsupported schema before constructing a provider request", async () => {
    const createMessage = vi.fn(async () => ({} as Anthropic.Message));
    await expect(
      structured("system", "content", {
        type: "object",
        properties: { text: { type: "string", maxLength: 10 } },
      }, { createMessage }),
    ).rejects.toThrow("maxLength");
    expect(createMessage).not.toHaveBeenCalled();
  });
});
