import type { Metadata } from "next";
export const metadata: Metadata = { referrer: "no-referrer", robots: { index: false, follow: false }, title: "Demeu — подготовка обследований" };
export default function PreparationLayout({ children }: { children: React.ReactNode }) { return children; }
