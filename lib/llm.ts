import Anthropic from "@anthropic-ai/sdk";

// Единый клиент. Ключ берётся из ANTHROPIC_API_KEY (или ant-профиля).
export const anthropic = new Anthropic();

// claude-sonnet-5: near-Opus качество на извлечении/классификации при
// заметно меньшей цене и задержке — подходит для разговорного триажа.
export const MODEL = "claude-sonnet-5";

// Разговорный ход опросника: коротко, без «размышлений», низкая задержка.
export async function chatTurn(
  system: string,
  messages: { role: "user" | "assistant"; content: string }[]
): Promise<string> {
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    thinking: { type: "disabled" },
    output_config: { effort: "low" },
    system,
    messages,
  });
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

// Структурированный вызов: возвращает JSON по схеме (извлечение/скоринг).
export async function structured<T>(
  system: string,
  userContent: string,
  schema: Record<string, unknown>
): Promise<T> {
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema },
    },
    system,
    messages: [{ role: "user", content: userContent }],
  });
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return JSON.parse(text) as T;
}
