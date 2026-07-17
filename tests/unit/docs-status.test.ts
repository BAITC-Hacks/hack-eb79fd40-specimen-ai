import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const readme = readFileSync("README.md", "utf8");
const handoff = readFileSync("HANDOFF.md", "utf8");
const deploy = readFileSync("deploy/DEPLOY.md", "utf8");
const tls = readFileSync("deploy/TLS.md", "utf8");
const envExample = readFileSync(".env.example", "utf8");

describe("release documentation status", () => {
  it("records accepted live evidence without overstating delivery or production", () => {
    expect(readme).toContain("два\n  запроса Anthropic");
    expect(readme).toContain("Telegram Bot API принял `sendMessage` и `sendDocument` с HTTP 200");
    expect(readme).toContain("не прочтение сводки человеком");
    expect(readme).toContain("воздержалась с `low_confidence`");
    expect(readme).toContain("`llm_fallback`");
    expect(readme).toContain("parity зелёный\n  на 150/150 примерах");
    expect(readme).toContain("публичный сертификат и независимый L1 smoke");
    expect(readme).toContain("сценарии 2–3 не\n  запускались без отдельного разрешения стоимости");
  });

  it("keeps the handoff aligned with completed and remaining work", () => {
    expect(handoff).toContain("LR-модель интегрирована в `analyze()`");
    expect(handoff).toContain("Read-only SSH-разведка VPS принята");
    expect(handoff).toContain("Получить явно разрешённый commit/push");
    expect(handoff).toContain("три production-сценария");
    expect(handoff).not.toMatch(/адаптер ещё не реализован|бот не создан|SSH[^.]*недоступен/iu);
    expect(handoff).not.toMatch(/Живой прогон против API ещё\s+не выполнялся/iu);
  });

  it("pins accepted branch B and distinguishes current live evidence from bare-IP work", () => {
    expect(envExample).toContain("TLS_BRANCH=branch-b-caddy");
    expect(envExample).not.toContain("TLS_BRANCH=branch-a-nginx");
    expect(deploy).toContain("ports 80, 443, and 3100 free");
    expect(deploy).toContain("TLS_BRANCH=branch-b-caddy");
    expect(deploy).toContain("exact-SHA branch-B deployment");
    expect(deploy).toContain("`default_sni` remediation is verified offline");
    expect(tls).toContain("выбрана ветка B");
    expect(tls).toContain("прошёл независимый L1 smoke");
    expect(tls).toContain("default_sni 109.123.248.16");
    expect(envExample).toContain("DEMEU_DOMAIN=109.123.248.16");
    expect(readme).toContain("`https://109.123.248.16`");
    expect(deploy).toContain("about 160 hours");
    expect(deploy).toContain("Do not use `down -v`");
    expect(deploy).toContain("sslip hostname as a rollback alias");
    for (const document of [deploy, tls]) {
      expect(document).toContain("curl -fsS https://109.123.248.16/api/healthz");
      expect(document).toContain("-noservername");
      expect(document).toContain("-servername 109.123.248.16");
    }
    expect(deploy).not.toContain("Agents do not connect to the VPS");
  });

  it("documents plural Telegram broadcast and legacy fallback consistently", () => {
    expect(envExample).toContain("TELEGRAM_DOCTOR_CHAT_IDS=");
    expect(envExample).toContain("TELEGRAM_DOCTOR_CHAT_ID=");
    expect(readme).toContain("`TELEGRAM_DOCTOR_CHAT_IDS`");
    expect(readme).toContain("Сбой одного получателя не блокирует остальных");
    expect(handoff).toContain("статус доставки остаётся агрегатным");
    expect(deploy).toContain("plural variable wins");
    expect(deploy).toContain(
      "Recipient-specific delivery state is intentionally not stored",
    );
  });
});
