"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { ReferralActor } from "@/lib/referrals/types";
import { advanceWorkspaceAuthEpoch, ROLE_LABELS, workspaceRequest } from "./client";
import { Icon } from "./ui";
import styles from "./shell.module.css";

const WorkspaceContext = createContext<{ actor: ReferralActor; logout: () => Promise<void> } | null>(null);
export function useWorkspaceContext() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("Workspace context is available only after authentication");
  return context;
}
const NAV = [
  { href: "/workspace", label: "Обзор", icon: "overview", section: "Рабочее пространство", private: false },
  { href: "/workspace/referrals", label: "Направления", icon: "referrals", section: "Рабочее пространство", private: true },
  { href: "/workspace/intakes", label: "Опросы пациентов", icon: "intakes", section: "Рабочее пространство", private: true },
  { href: "/workspace/calendar", label: "Календарь", icon: "calendar", section: "Рабочее пространство", private: true },
  { href: "/workspace/activity", label: "История подтверждений", icon: "activity", section: "Рабочее пространство", private: true },
  { href: "/workspace/analytics", label: "Аналитика", icon: "analytics", section: "Аналитика и данные", private: false },
  { href: "/workspace/data-quality", label: "Качество данных", icon: "data-quality", section: "Аналитика и данные", private: false },
  { href: "/workspace/settings", label: "Настройки", icon: "settings", section: "Управление", private: false },
];
type Auth = { actor: ReferralActor | null; enabled: boolean };

export default function WorkspaceShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [auth, setAuth] = useState<Auth | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const [logoutFailed, setLogoutFailed] = useState(false);
  const [forbiddenPath, setForbiddenPath] = useState<string | null>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const authGeneration = useRef(0);

  useEffect(() => {
    let active = true;
    const generation = ++authGeneration.current;
    workspaceRequest<Auth>("/api/workspace/auth").then((value) => { if (active && generation === authGeneration.current) { advanceWorkspaceAuthEpoch(); setAuth(value); setError(""); } })
      .catch((reason: Error) => { if (active && generation === authGeneration.current) setError(reason.message); });
    return () => { active = false; };
  }, [revision]);
  useEffect(() => {
    const expire = () => { advanceWorkspaceAuthEpoch(); authGeneration.current += 1; setAuth({ actor: null, enabled: true }); setError("Сеанс завершён. Войдите снова, чтобы продолжить."); setMenuOpen(false); };
    const forbidden = () => {
      // Hide children before rechecking rights. Keep this route blocked after
      // revalidation so a repeated 403 cannot create an automatic reload loop.
      advanceWorkspaceAuthEpoch(); authGeneration.current += 1; setForbiddenPath(pathname); setAuth(null); setMenuOpen(false); setRevision((value) => value + 1);
    };
    window.addEventListener("demeu:workspace-expired", expire);
    window.addEventListener("demeu:workspace-forbidden", forbidden);
    return () => { window.removeEventListener("demeu:workspace-expired", expire); window.removeEventListener("demeu:workspace-forbidden", forbidden); };
  }, [pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const mobile = window.matchMedia("(max-width: 820px)");
    const resize = () => { if (!mobile.matches) setMenuOpen(false); };
    mobile.addEventListener("change", resize);
    const focusable = () => Array.from(sidebar.current?.querySelectorAll<HTMLElement>("a[href],button") ?? []).filter((element) => element.getClientRects().length > 0);
    // Wait for the open class to reach layout: visibility was hidden when
    // the trigger was clicked, so an immediate focus can be ignored.
    let focusFrame = 0;
    const focusNavigation = () => {
      if (!mobile.matches) return;
      const target = sidebar.current?.querySelector<HTMLElement>('[aria-current="page"]') ?? focusable()[0];
      if (target && getComputedStyle(target).visibility === "visible") target.focus();
    };
    focusFrame = requestAnimationFrame(() => { focusFrame = requestAnimationFrame(focusNavigation); });
    const afterTransition = (event: TransitionEvent) => {
      if (event.target === sidebar.current && !sidebar.current?.contains(document.activeElement)) focusNavigation();
    };
    const navigationElement = sidebar.current;
    navigationElement?.addEventListener("transitionend", afterTransition);
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setMenuOpen(false); menuButton.current?.focus(); }
      if (event.key === "Tab") {
        const items = focusable();
        const first = items[0]; const last = items.at(-1);
        if (event.shiftKey && (document.activeElement === first || !sidebar.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !sidebar.current?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", close);
    return () => { cancelAnimationFrame(focusFrame); navigationElement?.removeEventListener("transitionend", afterTransition); document.removeEventListener("keydown", close); mobile.removeEventListener("change", resize); };
  }, [menuOpen]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true); setError("");
    try {
      const result = await workspaceRequest<{ actor: ReferralActor }>("/api/workspace/auth", { id: data.get("id"), password: data.get("password") });
      advanceWorkspaceAuthEpoch(); authGeneration.current += 1; form.reset(); setAuth({ actor: result.actor, enabled: true }); setLogoutFailed(false); setForbiddenPath(null);
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }
  async function logout() {
    advanceWorkspaceAuthEpoch(); authGeneration.current += 1; setAuth({ actor: null, enabled: true }); setMenuOpen(false); setBusy(true); setError(""); setForbiddenPath(null);
    try { await workspaceRequest("/api/workspace/auth", undefined, "DELETE"); setLogoutFailed(false); }
    catch { setLogoutFailed(true); setError("Не удалось завершить сеанс на сервере. Повторите выход."); }
    finally { setBusy(false); }
  }

  if (!auth?.actor) return <div className={`${styles.theme} ${styles.loginPage}`}>
    <section className={styles.loginStory} aria-label="О кабинете Demeu"><Link className={styles.loginBrand} href="/workspace">Demeu<span className={styles.brandMark}>+</span></Link><div className={styles.storyContent}><span className={styles.storyEyebrow}>Рабочее пространство команды</span><h1>Больше ясности.<br />На каждом этапе.</h1><p>Опрос пациента, подготовка направления и подтверждения врача — в одном кабинете.</p><div className={styles.storySteps}>{[["intakes", "Собрать контекст", "Сводка завершённого опроса"], ["referrals", "Подготовить направление", "Факты и комплектность пакета"], ["activity", "Сохранить историю", "Кто и когда подтвердил изменения"]].map(([icon, title, text]) => <div key={icon}><span><Icon name={icon} size={22} /></span><div><strong>{title}</strong><p>{text}</p></div></div>)}</div></div><p className={styles.storyFooter}>Поддержка работы врача. Финальное решение принимает специалист.</p></section>
    <section className={styles.loginMain}><div className={styles.loginFormWrap}><span className={styles.loginLock}><Icon name="lock" size={23} /></span><p className={styles.loginEyebrow}>Кабинет команды</p><h2>Добро пожаловать</h2><p className={styles.loginLead}>Войдите с учётной записью вашей организации.</p>
      {error && <div className={styles.error} role="alert">{error}{logoutFailed && <button className={styles.textButton} disabled={busy} onClick={() => void logout()}>Повторить выход</button>}</div>}
      {!auth ? error ? <button className={styles.primaryButton} onClick={() => { setError(""); setRevision((value) => value + 1); }}>Повторить подключение</button> : <p className={styles.loading} role="status"><span className={styles.spinner} />Подключаем рабочее пространство…</p> : !auth.enabled ? <div className={styles.configuration}><Icon name="info" /><h3>Кабинет пока не подключён</h3><p>Для входа нужна учётная запись вашей организации. Обратитесь к администратору команды.</p></div> : <form className={styles.loginForm} onSubmit={(event) => void login(event)}>
        <label>Учётная запись<input name="id" autoComplete="username" placeholder="Ваш идентификатор" required maxLength={128} disabled={busy} /></label>
        <label>Пароль<input name="password" type="password" autoComplete="current-password" placeholder="Введите пароль" required maxLength={1024} disabled={busy} /></label>
        <button className={styles.primaryButton} disabled={busy}>{busy ? "Подождите…" : <>Войти в кабинет<Icon name="arrow" size={18} /></>}</button>
      </form>}
      <p className={styles.loginHelp}><Icon name="data-quality" size={16} />Доступ определяется ролью и организацией.</p>
    </div><p className={styles.loginFoot}>Demeu · Подготовка направлений и первичный триаж</p></section>
  </div>;

  const actor = auth.actor;
  const navigation = NAV.filter((item) => actor.role !== "analyst" || !item.private);
  const section = NAV.find((item) => item.href === pathname) ?? NAV.find((item) => item.href !== "/workspace" && pathname.startsWith(`${item.href}/`));
  const denied = forbiddenPath === pathname || (actor.role === "analyst" && NAV.some((item) => item.private && (pathname === item.href || pathname.startsWith(`${item.href}/`))));
  const initials = actor.displayName.trim().split(/\s+/u).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  return <div className={styles.theme}>
    <a className={styles.skipLink} href="#workspace-content">Перейти к содержимому</a>
    {menuOpen && <button className={styles.backdrop} tabIndex={-1} aria-label="Закрыть меню" onClick={() => { setMenuOpen(false); menuButton.current?.focus(); }} />}
    <aside ref={sidebar} id="workspace-sidebar" className={`${styles.sidebar} ${menuOpen ? styles.sidebarOpen : ""}`}>
      <button className={styles.mobileClose} aria-label="Закрыть навигацию" onClick={() => { setMenuOpen(false); menuButton.current?.focus(); }}><Icon name="close" /></button>
      <Link href="/workspace" className={styles.wordmark} onClick={() => setMenuOpen(false)}>Demeu<span className={styles.brandMark}>+</span></Link>
      <div className={styles.workspaceScope}><span className={styles.organizationIcon}><Icon name="building" size={19} /></span><div><strong>{actor.organizationId}</strong><span>{actor.role === "doctor" ? "Ваши направления" : "Ваша организация"}</span></div></div>
      <nav className={styles.navigation} aria-label="Рабочее пространство">{["Рабочее пространство", "Аналитика и данные", "Управление"].map((group) => <div className={styles.navGroup} key={group}><p>{group}</p>{navigation.filter((item) => item.section === group).map((item) => {
        const selected = item.href === pathname || (item.href !== "/workspace" && pathname.startsWith(`${item.href}/`));
        return <Link key={item.href} className={`${styles.navLink} ${selected ? styles.navActive : ""}`} href={item.href} aria-current={selected ? "page" : undefined} onClick={() => setMenuOpen(false)}><Icon name={item.icon} size={19} /><span>{item.label}</span>{selected && <span className={styles.activeDot} />}</Link>;
      })}</div>)}</nav>
      <div className={styles.sidebarFooter}><span className={styles.footerIcon}><Icon name="data-quality" size={18} /></span><p>Персональный доступ<span>Только разрешённые вашей роли данные</span></p></div>
    </aside>
    <div className={styles.mainArea}><header className={styles.topbar}><div className={styles.breadcrumbs}><button ref={menuButton} className={styles.menuButton} type="button" aria-label={menuOpen ? "Закрыть навигацию" : "Открыть навигацию"} aria-expanded={menuOpen} aria-controls="workspace-sidebar" onClick={() => setMenuOpen((value) => !value)}><Icon name={menuOpen ? "close" : "menu"} /></button><span className={styles.breadcrumbParent}>Рабочее пространство</span><Icon name="chevron" size={13} /><span>{section?.label ?? "Карточка направления"}</span></div><div className={styles.account}><span className={styles.avatar} aria-hidden>{initials}</span><div className={styles.accountLabel}><strong>{actor.displayName}</strong><span>{ROLE_LABELS[actor.role]}</span></div><button className={styles.logoutButton} title="Выйти" aria-label="Выйти из кабинета" disabled={busy} onClick={() => void logout()}><Icon name="logout" size={18} /></button></div></header>
      <main className={styles.content} id="workspace-content" tabIndex={-1}>{denied ? <section className={styles.denied}><span className={styles.loginLock}><Icon name="lock" size={24} /></span><h1>{actor.role === "analyst" ? "Доступны сводные показатели" : "Доступ к разделу ограничен"}</h1><p>Права проверены повторно. Персональные карточки доступны сотрудникам, работающим с направлениями.</p><Link className={styles.primaryButton} href="/workspace/analytics">Перейти к аналитике</Link>{forbiddenPath === pathname && actor.role !== "analyst" && <button className={styles.textButton} onClick={() => setForbiddenPath(null)}>Повторить после проверки прав</button>}</section> : <WorkspaceContext.Provider key={`${actor.id}:${actor.role}:${actor.organizationId}`} value={{ actor, logout }}>{children}</WorkspaceContext.Provider>}</main>
    </div>
  </div>;
}
