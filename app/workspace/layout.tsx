import type { ReactNode } from "react";
import WorkspaceShell from "./shell";

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  const demo = process.env.DEMEU_LOCAL_DEMO === "1";
  const outbox = `http://127.0.0.1:${process.env.DEMEU_MOCK_TELEGRAM_PORT}/`;
  return <>
    {demo && <aside style={{ position: "relative", zIndex: 10, padding: "9px 16px", background: "#173b42", color: "white", font: "12px/1.45 system-ui" }}>
      Локальное демо · вымышленные данные · API имитируются<br />
      Вход: doctor-a / doctor-b / analyst / owner · DemeuDemo2026! · <a href={outbox} target="_blank" rel="noreferrer" style={{ color: "#b8f2e5" }}>Уведомления врачу</a>
    </aside>}
    <WorkspaceShell>{children}</WorkspaceShell>
  </>;
}
