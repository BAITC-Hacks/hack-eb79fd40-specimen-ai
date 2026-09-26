import type { Completeness } from "@/lib/referrals/types";

const MAX_VISIBLE_LABELS = 2;

function compact(labels: readonly string[]): string {
  const visible = labels.slice(0, MAX_VISIBLE_LABELS).join(", ");
  const remaining = labels.length - MAX_VISIBLE_LABELS;
  return remaining > 0 ? `${visible} +${remaining}` : visible;
}

export function packageGapLines(completeness: Completeness): string[] {
  if (!completeness.catalogueAvailable) {
    return [completeness.catalogueStatus === "available" && completeness.catalogueValidated === false
      ? "Перечень ожидает проверки врачом"
      : "Проверенный перечень недоступен"];
  }

  const missing = completeness.entries
    .filter((entry) => entry.status === "missing")
    .map((entry) => entry.label);
  const expired = completeness.entries
    .filter((entry) => entry.status === "expired")
    .map((entry) => entry.label);
  const lines: string[] = [];
  if (missing.length > 0) lines.push(`Нет: ${compact(missing)}`);
  if (expired.length > 0) lines.push(`Просрочено: ${compact(expired)}`);
  return lines;
}
