import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { runAnamnesisTurn } from "@/lib/anamnesis";
import {
  chatTurn,
  structured,
  type MessageCreatePort,
} from "@/lib/llm";

function message(content: Anthropic.Message["content"]): Anthropic.Message {
  return {
    id: "msg_test",
    container: null,
    content,
    model: "claude-sonnet-5",
    role: "assistant",
    stop_details: null,
    stop_reason: "end_turn",
    stop_sequence: null,
    type: "message",
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      input_tokens: 7,
      output_tokens: 4,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: "standard",
    },
  };
}

function capture(
  response: Anthropic.Message,
): {
  createMessage: MessageCreatePort;
  requests: Anthropic.MessageCreateParamsNonStreaming[];
  options: (Anthropic.RequestOptions | undefined)[];
} {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const options: (Anthropic.RequestOptions | undefined)[] = [];
  return {
    requests,
    options,
    createMessage: async (params, requestOptions) => {
      requests.push(params);
      options.push(requestOptions);
      return response;
    },
  };
}

describe("Anthropic adapter", () => {
  it("sends the low-latency chat request and joins text blocks", async () => {
    const fake = capture(
      message([
        { type: "text", text: " Короткий ", citations: null },
        { type: "text", text: "ответ ", citations: null },
      ]),
    );

    const result = await chatTurn(
      "system",
      [{ role: "user", content: "Мне нездоровится" }],
      fake,
    );

    expect(result).toBe("Короткий ответ");
    expect(fake.requests).toEqual([
      {
        model: "claude-sonnet-5",
        max_tokens: 1024,
        thinking: { type: "disabled" },
        output_config: { effort: "low" },
        system: "system",
        messages: [{ role: "user", content: "Мне нездоровится" }],
      },
    ]);
    expect(fake.options).toEqual([{ timeout: 30_000, maxRetries: 0 }]);
  });

  it("sends the structured request and parses its JSON response", async () => {
    const fake = capture(
      message([
        {
          type: "text",
          text: '{"summary":"готово"}',
          citations: null,
        },
      ]),
    );
    const schema = {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
      additionalProperties: false,
    };

    const result = await structured<{ summary: string }>(
      "extract",
      "patient transcript",
      schema,
      fake,
    );

    expect(result).toEqual({ summary: "готово" });
    expect(fake.requests).toEqual([
      {
        model: "claude-sonnet-5",
        max_tokens: 8000,
        thinking: { type: "adaptive" },
        output_config: {
          effort: "medium",
          format: { type: "json_schema", schema },
        },
        system: "extract",
        messages: [{ role: "user", content: "patient transcript" }],
      },
    ]);
    expect(fake.options).toEqual([{ timeout: 180_000, maxRetries: 0 }]);
  });

  it("starts the real questionnaire adapter boundary with the first user turn", async () => {
    const fake = capture(
      message([
        { type: "text", text: "Когда началось?", citations: null },
      ]),
    );

    await runAnamnesisTurn(
      [
        { role: "assistant", content: "Статическое приветствие" },
        { role: "user", content: "Болит голова" },
        { role: "assistant", content: "Где именно?" },
        { role: "user", content: "В висках" },
      ],
      {
        chatTurn: (system, messages) =>
          chatTurn(system, messages, fake),
      },
    );

    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].messages).toEqual([
      { role: "user", content: "Болит голова" },
      { role: "assistant", content: "Где именно?" },
      { role: "user", content: "В висках" },
    ]);
  });
});
