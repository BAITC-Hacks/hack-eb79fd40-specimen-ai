export type ProcessingMode = "external_llm" | "deterministic";

export function processingModeFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ProcessingMode {
  const value = env.DEMEU_PROCESSING_MODE?.trim() || "external_llm";
  if (value === "external_llm" || value === "deterministic") return value;
  throw new Error(
    "DEMEU_PROCESSING_MODE must be exactly external_llm or deterministic",
  );
}

/** Static for the lifetime of the server process. Invalid configuration fails at import. */
export const PROCESSING_MODE = processingModeFromEnv();
