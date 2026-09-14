import type { ReactNode } from "react";
import WorkspaceShell from "./shell";

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return <WorkspaceShell>{children}</WorkspaceShell>;
}
