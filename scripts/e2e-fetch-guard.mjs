const originalFetch = globalThis.fetch.bind(globalThis);
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

globalThis.fetch = async (input, init) => {
  const target = input instanceof Request ? input.url : String(input);
  const url = new URL(target);
  if (["http:", "https:"].includes(url.protocol) && !LOCAL_HOSTS.has(url.hostname)) {
    process.stderr.write(`E2E_EXTERNAL_FETCH_BLOCKED ${url.origin}\n`);
    throw new Error(`External fetch is forbidden in mock E2E: ${url.origin}`);
  }
  return originalFetch(input, init);
};

process.stderr.write("E2E_FETCH_GUARD_READY\n");
