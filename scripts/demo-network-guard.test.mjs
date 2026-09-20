import http from "node:http";
import assert from "node:assert/strict";

const server = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true, path: request.url }));
});
await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
try {
  process.env.DEMEU_MOCK_TELEGRAM_PORT = String(server.address().port);
  await import("./demo-fetch-router.mjs");
  const local = await fetch(`http://127.0.0.1:${server.address().port}/health`);
  assert.equal(local.status, 200);
  const telegram = await fetch("https://api.telegram.org/botlocal-mock-token/sendMessage", { method: "POST", body: "{}" });
  assert.equal(telegram.status, 200);
  assert.equal((await telegram.json()).path, "/botlocal-mock-token/sendMessage");
  await assert.rejects(fetch("https://example.com/"), /DEMEU_DEMO_EXTERNAL_FETCH_BLOCKED/u);
  await assert.rejects(fetch("https://api.telegram.org/bot-real-token/sendMessage"), /DEMEU_DEMO_EXTERNAL_FETCH_BLOCKED/u);
} finally {
  await new Promise((resolve) => server.close(resolve));
}
