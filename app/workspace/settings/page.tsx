"use client";

import { ROLE_LABELS } from "../client";
import { useWorkspaceContext } from "../shell";
import { Icon, PageHeading } from "../ui";
import styles from "../insights.module.css";

const ACCESS = {
  doctor: ["Собственные направления, опросы и история подтверждений.", "Создание ссылок и направлений, подтверждение фактов и обследований.", "Сводные показатели только по вашим направлениям."],
  owner: ["Направления, опросы и история подтверждений вашей организации.", "Создание направлений и подтверждение фактов в пределах организации.", "Сводные показатели организации. Данные других организаций недоступны."],
  analyst: ["Безопасные сводные показатели вашей организации.", "Персональные карточки, опросы, памятки и история пациентов недоступны.", "Создание ссылок и изменение направлений недоступны."],
};

export default function SettingsPage() {
  const { actor } = useWorkspaceContext();
  return <div className={styles.stack}>
    <PageHeading eyebrow="Управление" title="Настройки" description="Ваша учётная запись и границы доступа в рабочем пространстве." />
    <div className={styles.columns}>
      <section className={styles.card}>
        <div className={styles.profile}><span className={styles.avatar}><Icon name="users" size={28} /></span><div><h2>{actor.displayName}</h2><p className={styles.muted}>{ROLE_LABELS[actor.role]}</p></div></div>
        <dl className={styles.facts}><div><dt>Учётная запись</dt><dd>{actor.id}</dd></div><div><dt>Организация</dt><dd>{actor.organizationDisplayName}</dd></div><div><dt>Роль</dt><dd>{ROLE_LABELS[actor.role]}</dd></div><div><dt>Область данных</dt><dd>{actor.role === "doctor" ? "Только ваши записи" : actor.role === "analyst" ? "Агрегаты вашей организации" : "Записи вашей организации"}</dd></div></dl>
      </section>
      <section className={styles.card}><h2>Что доступно вашей роли</h2><p className={styles.muted}>Разрешения проверяются сервером при каждом запросе.</p><ul className={styles.permissions}>{ACCESS[actor.role].map((item) => <li key={item}><Icon name="lock" size={18} /><span>{item}</span></li>)}</ul></section>
    </div>
    <section className={styles.card}><div className={styles.sectionHead}><div><h2>Изменение учётной записи</h2><p className={styles.muted}>Управление выполняет администратор серверной конфигурации.</p></div><span className={styles.tag}><Icon name="lock" size={14} />Только просмотр</span></div>
      <dl className={styles.sourceList}><div><dt>Имя, пароль, роль и организация</dt><dd>Для изменения обратитесь к администратору команды. Веб-управление пользователями и самостоятельная смена пароля пока не реализованы. Роль руководителя не даёт доступа к серверной конфигурации.</dd></div><div><dt>Получатель Telegram</dt><dd>Администратор связывает получателя с учётной записью врача. Канал односторонний: Demeu отправляет уведомления, но ответы боту в кабинет не поступают. Состояние подключения не проверяется на этой странице; сообщения о доставке появляются при соответствующем действии.</dd></div><div><dt>Отзыв доступа</dt><dd>Сообщите администратору, если нужно завершить доступ на других устройствах или изменить принадлежность к организации. Кнопка выхода завершает сеанс только в текущем браузере.</dd></div></dl>
    </section>
    <div className={styles.notice}><Icon name="data-quality" size={19} /><div><strong>Доступ не равен медицинскому решению</strong>Подтверждение направления, очереди и явки остаётся явным действием врача. Изменение роли не подтверждает факты автоматически.</div></div>
  </div>;
}
