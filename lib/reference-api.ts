import {
  DEFAULT_REQUIREMENTS,
  validateRequirementCatalogue,
} from "./referrals/requirements";
import type {
  ExaminationRequirement,
  RequirementCatalogue,
} from "./referrals/types";
import {
  isWorkspaceAuthError,
  requireWorkspaceActor,
  WorkspaceAuthError,
  type WorkspaceActor,
} from "./workspace-auth";

export type ReferenceValidationStatus = "validated" | "unvalidated";

export interface ExaminationRequirementsReference {
  schemaVersion: 1;
  catalogue: {
    id: "b1-examination-requirements-v1";
    version: string;
    status: RequirementCatalogue["status"];
    source: string | null;
    scope: RequirementCatalogue["scope"];
    validated: boolean;
    validationStatus: ReferenceValidationStatus;
  };
  summary: {
    profileCount: number;
    requirementOccurrenceCount: number;
    uniqueRequirementCount: number;
  };
  profiles: {
    profile: string;
    requirements: ExaminationRequirement[];
  }[];
}

export interface ReferenceApiDeps {
  actor?: (req: Request) => Promise<WorkspaceActor>;
  catalogue?: unknown;
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: NO_STORE });
}

function failure(status: number, code: string): never {
  throw new WorkspaceAuthError(status, code);
}

async function boundary(work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    if (isWorkspaceAuthError(error)) {
      const messages: Record<string, string> = {
        BAD_REQUEST: "Query-параметры недоступны",
        METHOD_NOT_ALLOWED: "Метод недоступен",
        UNAUTHORIZED: "Требуется вход",
        WORKSPACE_UNAVAILABLE: "Рабочее пространство недоступно",
      };
      return json({ code: error.code, error: messages[error.code] ?? "Нет доступа" }, error.status);
    }
    return json({ code: "REFERENCE_CATALOGUE_UNAVAILABLE", error: "Справочник обследований недоступен" }, 503);
  }
}

export function buildExaminationRequirementsReference(
  value: unknown = DEFAULT_REQUIREMENTS,
): ExaminationRequirementsReference {
  const catalogue = validateRequirementCatalogue(value);
  const requirementIds = new Set<string>();
  let requirementOccurrenceCount = 0;

  for (const profile of catalogue.profiles) {
    requirementOccurrenceCount += profile.requirements.length;
    for (const requirement of profile.requirements) requirementIds.add(requirement.id);
  }

  return {
    schemaVersion: 1,
    catalogue: {
      id: "b1-examination-requirements-v1",
      version: catalogue.version,
      status: catalogue.status,
      source: catalogue.source,
      scope: catalogue.scope ?? null,
      validated: catalogue.validated,
      validationStatus: catalogue.validated ? "validated" : "unvalidated",
    },
    summary: {
      profileCount: catalogue.profiles.length,
      requirementOccurrenceCount,
      uniqueRequirementCount: requirementIds.size,
    },
    profiles: catalogue.profiles,
  };
}

export function handleExaminationRequirementsReference(
  req: Request,
  deps: ReferenceApiDeps = {},
): Promise<Response> {
  return boundary(async () => {
    await (deps.actor ?? requireWorkspaceActor)(req);
    if (req.method !== "GET") failure(405, "METHOD_NOT_ALLOWED");
    if (new URL(req.url).search) failure(400, "BAD_REQUEST");
    return json(buildExaminationRequirementsReference(deps.catalogue ?? DEFAULT_REQUIREMENTS));
  });
}
