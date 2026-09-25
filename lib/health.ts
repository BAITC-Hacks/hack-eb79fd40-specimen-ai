export interface HealthResponse {
  ok: true;
  commit: string;
  model_version: string;
  llm_ok: boolean;
  processing_mode: "external_llm" | "deterministic";
}

export function buildHealthResponse(
  env: Readonly<Record<string, string | undefined>> = process.env,
): HealthResponse {
  const artifact = loadArtifact();
  const processing_mode = processingModeFromEnv(env);
  return {
    ok: true,
    commit: env.COMMIT_SHA ?? "unknown",
    model_version: artifact.model_version,
    llm_ok: Boolean(env.ANTHROPIC_API_KEY),
    processing_mode,
  };
}
import { loadArtifact } from "./model";
import { processingModeFromEnv } from "./processing-mode";
