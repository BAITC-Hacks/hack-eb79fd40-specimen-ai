import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { REFERRAL_RISK_FEATURES, scoreReferralRiskEncoded, validateReferralRiskArtifact, type ReferralRiskEncodedInputs } from "../../lib/referral-risk";

const artifactPath = process.argv[2];
if (!artifactPath) throw new Error("artifact_path_required");
const artifact = validateReferralRiskArtifact(JSON.parse(await readFile(artifactPath, "utf8")));
let rows = 0;
let maximumAbsoluteProbabilityDelta = 0;
let riskBandMismatches = 0;
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  const parts = line.split("\t");
  if (parts.length !== REFERRAL_RISK_FEATURES.length + 1) throw new Error("invalid_private_parity_row");
  const expected = Number(parts[0]);
  if (!Number.isFinite(expected)) throw new Error("invalid_private_parity_probability");
  const encoded = Object.fromEntries(REFERRAL_RISK_FEATURES.map((feature, index) => {
    const token = parts[index + 1];
    if (token === "-") return [feature, { missing: true }];
    if (!/^[a-f0-9]{64}$/u.test(token)) throw new Error("invalid_private_parity_token");
    return [feature, { token }];
  })) as ReferralRiskEncodedInputs;
  const actual = scoreReferralRiskEncoded(encoded, artifact);
  maximumAbsoluteProbabilityDelta = Math.max(maximumAbsoluteProbabilityDelta, Math.abs(expected - actual.refusalProbabilityAmongMatureOutcomes));
  if ((expected >= actual.workingThreshold) !== (actual.riskBand === "at_or_above_working_threshold")) riskBandMismatches += 1;
  rows += 1;
}
process.stdout.write(JSON.stringify({ rows, maximumAbsoluteProbabilityDelta, riskBandMismatches }));
