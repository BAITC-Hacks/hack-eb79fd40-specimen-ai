import type { ReactNode } from "react";

export default function PatientLayout({ children }: { children: ReactNode }) {
  return <>
    {process.env.DEMEU_LOCAL_DEMO === "1" && <aside style={{ position: "relative", zIndex: 10, padding: "9px 16px", background: "#173b42", color: "white", font: "12px/1.45 system-ui" }}>
      Локальное демо · вымышленные данные · ответы помощника имитируются
    </aside>}
    {children}
  </>;
}
