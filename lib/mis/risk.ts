import {
  loadReferralRiskArtifact, REFERRAL_RISK_FEATURES, scoreReferralRisk,
} from "../referral-risk";
import type { RegistrationFeatures } from "../referrals/types";
import type { MisRiskEvaluation, MisRiskPort } from "./types";

const LIMITATIONS = [
  "Исследовательская оценка среди зрелых исходов; не прогноз клинического результата.",
  "Не влияет на решение врача, маршрут, срочность или комплектность.",
  "Лицензия исходного набора не проверена.",
] as const;

function complete(features: Readonly<RegistrationFeatures>): boolean {
  return REFERRAL_RISK_FEATURES.every((feature) => feature === "bed_profile"
    ? features[feature] === null || typeof features[feature] === "string"
    : typeof features[feature] === "string" && features[feature]!.length > 0);
}

export const verifiedReferralRiskPort: MisRiskPort = {
  async evaluate(features): Promise<MisRiskEvaluation> {
    if (!complete(features)) return { status: "unavailable", researchOnly: true, reason: "INPUTS_INCOMPLETE" };
    let artifact;
    try { artifact = await loadReferralRiskArtifact(); }
    catch { return { status: "unavailable", researchOnly: true, reason: "ARTIFACT_UNAVAILABLE" }; }
    try {
      const score = scoreReferralRisk(features, artifact);
      return {
        status: "available",
        researchOnly: true,
        modelVersion: artifact.modelId,
        refusalProbabilityAmongMatureOutcomes: score.refusalProbabilityAmongMatureOutcomes,
        workingThreshold: score.workingThreshold,
        riskBand: score.riskBand,
        limitations: [...LIMITATIONS],
      };
    } catch {
      return { status: "unavailable", researchOnly: true, reason: "ARTIFACT_INVALID" };
    }
  },
};
