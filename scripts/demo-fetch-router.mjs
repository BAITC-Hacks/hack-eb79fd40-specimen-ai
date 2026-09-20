const originalFetch = globalThis.fetch.bind(globalThis);
const localHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

globalThis.fetch = async (input, init) => {
  const target = new URL(input instanceof Request ? input.url : String(input));
  if (target.hostname === "api.telegram.org" && target.pathname.startsWith("/botlocal-mock-token/")) {
    const port = Number(process.env.DEMEU_MOCK_TELEGRAM_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Local Telegram mock is unavailable");
    const local = `http://127.0.0.1:${port}${target.pathname}${target.search}`;
    return originalFetch(input instanceof Request ? new Request(local, input) : local, init);
  }
  if (!["http:", "https:"].includes(target.protocol) || !localHosts.has(target.hostname)) {
    throw new Error(`DEMEU_DEMO_EXTERNAL_FETCH_BLOCKED ${target.origin}`);
  }
  return originalFetch(input, init);
};

process.stderr.write("DEMEU_DEMO_FETCH_GUARD_READY\n");
