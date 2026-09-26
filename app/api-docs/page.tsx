import type { Metadata } from "next";
import { apiDocsBaseUrl } from "@/lib/api-docs-origin";
import { ApiDocsPortal } from "./portal";

export const metadata: Metadata = {
  title: "Demeu API — справочник интеграции",
  description: "Интерактивный каталог API Demeu: контракты, ошибки, примеры и клинические потоки.",
};

// APP_BASE_URL is injected into the running container, not the image build.
// Keep this page dynamic so copied examples use the active deployment origin.
export const dynamic = "force-dynamic";

export default function ApiDocsPage() {
  return <ApiDocsPortal baseUrl={apiDocsBaseUrl()} />;
}
