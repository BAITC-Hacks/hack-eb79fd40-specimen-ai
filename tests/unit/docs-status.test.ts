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
    expect(readme).toContain("публичные HTTPS/TLS, L1/L2\nsmoke и три сценария на production пока не заявляются как выполненные");
  });

  it("keeps the handoff aligned with completed and remaining work", () => {
    expect(handoff).toContain("LR-модель интегрирована в `analyze()`");
    expect(handoff).toContain("Read-only SSH-разведка VPS принята");
    expect(handoff).toContain("Получить явно разрешённый commit/push");
    expect(handoff).toContain("три production-сценария");
    expect(handoff).not.toMatch(/адаптер ещё не реализован|бот не создан|SSH[^.]*недоступен/iu);
    expect(handoff).not.toMatch(/Живой прогон против API ещё\s+не выполнялся/iu);
  });

  it("pins accepted branch B while leaving public acceptance pending", () => {
    expect(envExample).toContain("TLS_BRANCH=branch-b-caddy");
    expect(envExample).not.toContain("TLS_BRANCH=branch-a-nginx");
    expect(deploy).toContain("ports 80, 443, and 3100 free");
    expect(deploy).toContain("TLS_BRANCH=branch-b-caddy");
    expect(deploy).toContain("stopped before transfer or\nbuild");
    expect(tls).toContain("выбрана ветка B");
    expect(tls).toContain("публичный HTTPS/smoke ещё **не проверены**");
    expect(deploy).not.toContain("Agents do not connect to the VPS");
  });
});
