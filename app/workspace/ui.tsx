import type { ReactNode } from "react";
import type { ReferralFlow } from "@/lib/referrals/types";
import { FLOW_LABELS } from "./client";
import styles from "./workspace.module.css";

const paths: Record<string, ReactNode> = {
  overview: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  referrals: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" /><path d="M14 3v6h6M8 13h8M8 17h5" /></>,
  intakes: <><path d="M21 11a8 8 0 0 1-8 8H6l-4 3V11a9 9 0 0 1 18 0Z" /><path d="M7 10h9M7 14h6" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 11h18M7 15h2M13 15h2M7 18h2" /></>,
  activity: <><path d="M3 12h4l3-7 4 14 3-7h4" /></>,
  analytics: <><path d="M4 3v17h17M8 15v-4M13 15V7M18 15v-7" /></>,
  "data-quality": <><path d="m12 3 8 4v5c0 5-8 9-8 9S4 17 4 12V7Z" /><path d="m8.5 12 2.5 2.5 4.5-5" /></>,
  settings: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" /><circle cx="15" cy="17" r="3" /></>,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  logout: <><path d="M9 4H4v16h5M10 12h11m-4-4 4 4-4 4" /></>,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  plus: <path d="M12 5v14M5 12h14" />,
  search: <><circle cx="10" cy="10" r="6" /><path d="m15 15 6 6" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  warning: <><path d="m12 3 10 18H2Z" /><path d="M12 9v5M12 17v.2" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7v.2" /></>,
  users: <><circle cx="9" cy="8" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 5" /></>,
  building: <><path d="M4 21V5l8-2v18M12 9h8v12M2 21h20M7 8h2M7 12h2M7 16h2M15 12h2M15 16h2" /></>,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></>,
  download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" /></>,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5M20 12a8 8 0 0 0-14-5M4 12a8 8 0 0 0 14 5" /></>,
  inbox: <><path d="m5 4-3 11v6h20v-6L19 4ZM2 15h6l2 3h4l2-3h6" /></>,
};
export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const aliases: Record<string, string> = { dashboard: "overview", file: "referrals", clipboard: "referrals", chart: "analytics", shield: "data-quality", user: "users", folder: "referrals", alert: "warning", link: "arrow", send: "arrow" };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[aliases[name] ?? name] ?? paths.referrals}</svg>;
}
export function PageHeading({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return <div className={styles.pageHeading}><div>{eyebrow && <p className={styles.eyebrow}>{eyebrow}</p>}<h1>{title}</h1>{description && <p className={styles.muted}>{description}</p>}</div>{actions && <div className={styles.row}>{actions}</div>}</div>;
}
export function KpiCard({ label, value, hint, icon }: { label: string; value: ReactNode; hint?: string; icon?: string }) {
  return <section className={styles.kpiCard}><div className={styles.between}><p className={styles.kpiLabel}>{label}</p>{icon && <span className={styles.kpiIcon}><Icon name={icon} size={19} /></span>}</div><div className={styles.kpiValue}>{value}</div>{hint && <p className={styles.small}>{hint}</p>}</section>;
}
export function StatusBadge({ flow }: { flow: ReferralFlow }) {
  const color = flow === "cancelled" || flow === "not_attended" ? "negative" : flow === "waiting" || flow === "preparing" ? "attention" : flow === "ready" || flow === "attended" ? "positive" : "neutral";
  return <span className={styles.badge} data-tone={color}><span className={styles.statusDot} />{FLOW_LABELS[flow]}</span>;
}
export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return <div className={styles.emptyState}><span className={styles.emptyIcon}><Icon name="inbox" size={25} /></span><h3>{title}</h3>{description && <p>{description}</p>}{action && <div>{action}</div>}</div>;
}
