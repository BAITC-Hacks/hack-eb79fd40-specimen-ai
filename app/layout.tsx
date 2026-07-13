import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Demeu — первичный триаж",
  description: "AI-ассистент сбора анамнеза и маршрутизации для госполиклиник",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
