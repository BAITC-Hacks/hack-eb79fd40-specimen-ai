export interface HealthResponse {
  ok: true;
  commit: string;
  model_version: string;
  llm_ok: boolean;
}

export function buildHealthResponse(
  env: Readonly<Record<string, string | undefined>> = process.env,
): HealthResponse {
  const artifact = loadArtifact();
  return {
    ok: true,
    commit: env.COMMIT_SHA ?? "unknown",
    model_version: artifact.model_version,
    llm_ok: Boolean(env.ANTHROPIC_API_KEY),
  };
}
import { loadArtifact } from "./model";
