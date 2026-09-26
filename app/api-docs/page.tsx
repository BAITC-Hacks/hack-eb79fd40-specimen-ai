import type { Metadata } from "next";
import { ApiDocsPortal } from "./portal";

export const metadata: Metadata = {
  title: "Demeu API — справочник интеграции",
  description: "Интерактивный каталог API Demeu: контракты, ошибки, примеры и клинические потоки.",
};

// APP_BASE_URL is injected into the running container, not the image build.
// Keep this page dynamic so copied examples use the active deployment origin.
export const dynamic = "force-dynamic";

export default function ApiDocsPage() {
  const baseUrl = (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/u, "");
  return <ApiDocsPortal baseUrl={baseUrl} />;
}
