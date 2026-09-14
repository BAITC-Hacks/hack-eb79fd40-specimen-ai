"use client";

import { useEffect, useState } from "react";
import { workspaceRequest } from "./client";
import { useWorkspaceContext } from "./shell";

export function useInsightData<T>(url: string) {
  const { actor } = useWorkspaceContext();
  const identity = `${actor.id}:${actor.organizationId}:${actor.role}:${url}`;
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ identity: string; revision: number; data?: T; error?: string } | null>(null);
  useEffect(() => {
    let active = true;
    workspaceRequest<T>(url)
      .then((data) => { if (active) setResult({ identity, revision, data }); })
      .catch((reason: Error) => { if (active) setResult({ identity, revision, error: reason.message }); });
    return () => { active = false; };
  }, [identity, revision, url]);
  // Never render a previous account, endpoint or refresh result as current data.
  const current = result?.identity === identity && result.revision === revision ? result : null;
  return { data: current?.data, error: current?.error, loading: !current, refresh: () => setRevision((value) => value + 1) };
}
