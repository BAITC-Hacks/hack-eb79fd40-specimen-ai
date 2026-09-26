"use client";

import { useMemo, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import {
  apiEndpoints,
  apiGroups,
  codeExample,
  flowStories,
  type ApiEndpoint,
  type CodeLanguage,
} from "@/lib/api-catalog";
import styles from "../api-docs.module.css";

const methodClass: Record<ApiEndpoint["method"], string> = {
  GET: styles.get,
  POST: styles.post,
  DELETE: styles.delete,
};

const codeLanguages = ["curl", "fetch"] as const;

function Mark() {
  return (
    <svg viewBox="0 0 44 44" aria-hidden="true" className={styles.mark}>
      <path d="M22 4.5c7.7 0 14 6.3 14 14 0 10.6-14 21-14 21s-14-10.4-14-21c0-7.7 6.3-14 14-14Z" />
      <path d="M15.5 20h4.1l1.7-5.1 2.6 10.2 1.9-5.1h3" />
    </svg>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button className={styles.copy} type="button" onClick={copy} aria-label={`Копировать ${label}`}>
      <span aria-hidden="true">{copied ? "✓" : "⧉"}</span>
      {copied ? "Скопировано" : "Копировать"}
    </button>
  );
}

function Method({ value }: { value: ApiEndpoint["method"] }) {
  return <span className={`${styles.method} ${methodClass[value]}`}>{value}</span>;
}

function EndpointCard({ endpoint, language, baseUrl }: { endpoint: ApiEndpoint; language: CodeLanguage; baseUrl: string }) {
  const requestCode = codeExample(endpoint, language, baseUrl);
  const responseCode = JSON.stringify(endpoint.success.example, null, 2);
  return (
    <article className={styles.endpoint} id={endpoint.id} data-api-endpoint>
      <div className={styles.endpointHead}>
        <div>
          <div className={styles.operation}>
            <Method value={endpoint.method} />
            <code>{endpoint.path}</code>
          </div>
          <h3>{endpoint.summary}</h3>
          <p>{endpoint.description}</p>
        </div>
        <a href={`#${endpoint.id}`} className={styles.anchor} aria-label={`Ссылка на ${endpoint.summary}`}>#</a>
      </div>

      <div className={styles.endpointGrid}>
        <div className={styles.contract}>
          <section aria-labelledby={`${endpoint.id}-access`}>
            <p className={styles.sectionLabel} id={`${endpoint.id}-access`}>Доступ</p>
            <div className={styles.accessLine}>
              <span className={`${styles.authDot} ${styles[endpoint.auth.kind]}`} aria-hidden="true" />
              <div><strong>{endpoint.auth.label}</strong><p>{endpoint.auth.detail}</p></div>
            </div>
          </section>

          <section aria-labelledby={`${endpoint.id}-request`}>
            <p className={styles.sectionLabel} id={`${endpoint.id}-request`}>Запрос</p>
            {endpoint.request.fields.length > 0 ? (
              <div className={styles.fields} role="list">
                {endpoint.request.fields.map((item) => (
                  <div className={styles.field} role="listitem" key={item.name}>
                    <div><code>{item.name}</code><span>{item.type}</span></div>
                    <p>{item.description}</p>
                    <small>{item.required ? "обязательно" : "опционально"}</small>
                  </div>
                ))}
              </div>
            ) : <p className={styles.empty}>Параметры не требуются.</p>}
            {endpoint.request.note && <p className={styles.note}>{endpoint.request.note}</p>}
          </section>

          <section aria-labelledby={`${endpoint.id}-errors`}>
            <p className={styles.sectionLabel} id={`${endpoint.id}-errors`}>Ошибки</p>
            <div className={styles.errors}>
              {endpoint.errors.map((item) => (
                <div key={`${item.status}-${item.code ?? JSON.stringify(item.response)}`}>
                  <span>{item.status}</span><code>{item.code ?? "JSON body"}</code><p>{item.meaning}</p>
                  {item.response !== undefined && (
                    <pre className={styles.errorBody}><code>{JSON.stringify(item.response, null, 2)}</code></pre>
                  )}
                </div>
              ))}
            </div>
          </section>

          {endpoint.notes && (
            <aside className={styles.notes} aria-label="Инварианты">
              <p className={styles.sectionLabel}>Важно</p>
              <ul>{endpoint.notes.map((note) => <li key={note}>{note}</li>)}</ul>
            </aside>
          )}
        </div>

        <div className={styles.examples}>
          <div className={styles.codeCard}>
            <div className={styles.codeBar}>
              <span>{language === "curl" ? "Terminal" : "Browser / TypeScript"}</span>
              <CopyButton value={requestCode} label={`пример запроса ${endpoint.path}`} />
            </div>
            <pre><code>{requestCode}</code></pre>
          </div>
          <div className={`${styles.codeCard} ${styles.responseCard}`}>
            <div className={styles.codeBar}>
              <span><b>{endpoint.success.status}</b> · {endpoint.success.description}</span>
              <CopyButton value={responseCode} label={`пример ответа ${endpoint.path}`} />
            </div>
            <pre><code>{responseCode}</code></pre>
          </div>
        </div>
      </div>
    </article>
  );
}

export function ApiDocsPortal({ baseUrl }: { baseUrl: string }) {
  const [query, setQuery] = useState("");
  const [language, setLanguage] = useState<CodeLanguage>("curl");
  const normalized = query.trim().toLocaleLowerCase("ru");
  const visible = useMemo(() => apiEndpoints.filter((endpoint) => {
    if (!normalized) return true;
    return [endpoint.method, endpoint.path, endpoint.summary, endpoint.description, endpoint.groupId,
      ...endpoint.errors.map((item) => item.code ?? JSON.stringify(item.response))]
      .join(" ").toLocaleLowerCase("ru").includes(normalized);
  }), [normalized]);
  const visibleIds = new Set(visible.map((endpoint) => endpoint.id));

  function handleLanguageKeyDown(event: KeyboardEvent<HTMLButtonElement>, current: CodeLanguage) {
    const currentIndex = codeLanguages.indexOf(current);
    let next: CodeLanguage | undefined;

    if (event.key === "ArrowRight") next = codeLanguages[(currentIndex + 1) % codeLanguages.length];
    if (event.key === "ArrowLeft") next = codeLanguages[(currentIndex - 1 + codeLanguages.length) % codeLanguages.length];
    if (event.key === "Home") next = codeLanguages[0];
    if (event.key === "End") next = codeLanguages[codeLanguages.length - 1];
    if (!next) return;

    event.preventDefault();
    setLanguage(next);
    document.getElementById(`language-tab-${next}`)?.focus();
  }

  return (
    <div className={styles.page}>
      <a className={styles.skip} href="#api-content">К содержанию API</a>
      <header className={styles.topbar}>
        <Link className={styles.logo} href="/" aria-label="Demeu — на главную">
          <Mark />
          <span><strong>Demeu</strong><small>API field guide</small></span>
        </Link>
        <div className={styles.environment} aria-label="Контур примеров">
          <span /> production contract
        </div>
        <Link className={styles.workspaceLink} href="/workspace">Рабочее пространство <span aria-hidden="true">↗</span></Link>
      </header>

      <aside className={styles.sidebar} aria-label="Навигация по API">
        <label className={styles.search}>
          <span aria-hidden="true">⌕</span>
          <span className={styles.visuallyHidden}>Найти эндпоинт</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Эндпоинт или ошибка" type="search" />
          <kbd>/</kbd>
        </label>
        <nav>
          <a className={styles.overviewLink} href="#overview"><span>Обзор</span><small>{apiEndpoints.length}</small></a>
          <a className={styles.overviewLink} href="#flows"><span>Сквозные пути</span><small>3</small></a>
          {apiGroups.map((group) => {
            const endpoints = apiEndpoints.filter((endpoint) => endpoint.groupId === group.id && visibleIds.has(endpoint.id));
            if (endpoints.length === 0) return null;
            return (
              <div className={styles.navGroup} key={group.id}>
                <p>{group.eyebrow}</p>
                {endpoints.map((endpoint) => (
                  <a
                    href={`#${endpoint.id}`}
                    key={endpoint.id}
                    aria-label={`${endpoint.method} — ${endpoint.summary} — ${endpoint.path}`}
                    data-mobile-endpoint-link
                  >
                    <Method value={endpoint.method} />
                    <span>{endpoint.summary}</span>
                  </a>
                ))}
              </div>
            );
          })}
        </nav>
        <div className={styles.sidebarFoot}>
          <span>v1 · 2026-09</span>
          <span className={styles.statusDot}>контракт активен</span>
        </div>
      </aside>

      <main className={styles.main} id="api-content">
        <section className={styles.hero} id="overview">
          <div className={styles.heroCopy}>
            <p className={styles.kicker}>Интеграционный справочник · Demeu</p>
            <h1>API, который следует<br /><em>пути пациента.</em></h1>
            <p className={styles.lead}>Не машинная схема, а рабочая карта: кто вызывает операцию, какие данные проходят границу и где решение остаётся за врачом.</p>
            <div className={styles.heroActions}>
              <a href="#flows" className={styles.primaryAction}>Пройти сквозной путь <span aria-hidden="true">↓</span></a>
              <span>Base URL <code>{baseUrl}</code></span>
            </div>
          </div>
          <div className={styles.heroPanel} aria-label="Инварианты API">
            <div><span>01</span><p><strong>Правила имеют приоритет</strong>Красный флаг не может быть понижен моделью.</p></div>
            <div><span>02</span><p><strong>Доставка идемпотентна</strong>Повторный finalize не дублирует сводку.</p></div>
            <div><span>03</span><p><strong>Роли разделены сервером</strong>Аналитик не получает персональный слой.</p></div>
          </div>
        </section>

        <section className={styles.flowSection} id="flows" aria-labelledby="flows-title">
          <div className={styles.sectionIntro}>
            <div><p className={styles.kicker}>Clinical flow stories</p><h2 id="flows-title">Три пути, одна модель доступа</h2></div>
            <p>Нажмите на шаг, чтобы перейти к точному контракту. Все идентификаторы и данные ниже вымышлены.</p>
          </div>
          <div className={styles.flowGrid}>
            {flowStories.map((story) => (
              <article className={styles.flowCard} key={story.id}>
                <div className={styles.flowTitle}><span>{story.index}</span><h3>{story.title}</h3></div>
                <p>{story.outcome}</p>
                <ol>
                  {story.steps.map((step, index) => (
                    <li key={step.endpointId}>
                      <a href={`#${step.endpointId}`}>
                        <span>{String(index + 1).padStart(2, "0")}</span>
                        <div><strong>{step.label}</strong><small>{step.detail}</small></div>
                        <b aria-hidden="true">↗</b>
                      </a>
                    </li>
                  ))}
                </ol>
              </article>
            ))}
          </div>
        </section>

        <div className={styles.catalogueHead}>
          <div><p className={styles.kicker}>Reference</p><h2>Каталог операций</h2></div>
          <div className={styles.languageTabs} role="tablist" aria-label="Язык примеров">
            {codeLanguages.map((item) => (
              <button
                id={`language-tab-${item}`}
                key={item}
                type="button"
                role="tab"
                aria-controls="language-examples-panel"
                aria-selected={language === item}
                tabIndex={language === item ? 0 : -1}
                onClick={() => setLanguage(item)}
                onKeyDown={(event) => handleLanguageKeyDown(event, item)}
              >
                {item === "curl" ? "cURL" : "Fetch"}
              </button>
            ))}
          </div>
        </div>

        <div
          id="language-examples-panel"
          role="tabpanel"
          aria-labelledby={`language-tab-${language}`}
          tabIndex={0}
        >
          {visible.length === 0 && (
            <div className={styles.noResults} role="status">
              <span>∅</span><h2>Ничего не найдено</h2><p>Попробуйте путь, метод или код ошибки — например, <code>REVISION_CONFLICT</code>.</p>
              <button type="button" onClick={() => setQuery("")}>Сбросить поиск</button>
            </div>
          )}

          {apiGroups.map((group) => {
            const endpoints = visible.filter((endpoint) => endpoint.groupId === group.id);
            if (endpoints.length === 0) return null;
            return (
              <section className={styles.group} id={`group-${group.id}`} key={group.id} aria-labelledby={`group-${group.id}-title`}>
                <div className={styles.groupHead}>
                  <p>{group.eyebrow}</p>
                  <div><h2 id={`group-${group.id}-title`}>{group.title}</h2><span>{group.description}</span></div>
                </div>
                {endpoints.map((endpoint) => <EndpointCard endpoint={endpoint} language={language} baseUrl={baseUrl} key={endpoint.id} />)}
              </section>
            );
          })}
        </div>

        <footer className={styles.footer}>
          <Mark /><p><strong>Demeu API</strong><span>Контракт описывает поведение сервера, но финальное клиническое решение всегда принимает врач.</span></p>
          <a href="#overview">Наверх ↑</a>
        </footer>
      </main>
    </div>
  );
}
