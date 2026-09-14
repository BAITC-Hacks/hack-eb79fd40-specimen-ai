import { resolve } from "node:path";
import { FileReferralRepository, ReferralService } from "./referrals/service";
import { WorkspaceAuthError, workspaceEnabled } from "./workspace-auth";

const globals = globalThis as typeof globalThis & {
  __demeuReferralRuntime?: { path: string; service: ReferralService };
};

// Lazy initialization keeps builds and the disabled public chat free of disk writes.
export function workspace(): ReferralService {
  if (!workspaceEnabled()) throw new WorkspaceAuthError(503, "WORKSPACE_UNAVAILABLE");
  const path = resolve(process.env.DEMEU_DATA_DIR!, "referrals.json");
  if (globals.__demeuReferralRuntime && globals.__demeuReferralRuntime.path !== path) {
    throw new WorkspaceAuthError(503, "WORKSPACE_UNAVAILABLE");
  }
  if (!globals.__demeuReferralRuntime) {
    globals.__demeuReferralRuntime = { path, service: new ReferralService(new FileReferralRepository(path)) };
  }
  return globals.__demeuReferralRuntime.service;
}
