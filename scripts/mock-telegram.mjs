import http from "node:http";

const port = Number(process.env.MOCK_TELEGRAM_PORT ?? 0);
const outbox = [];
const documents = new Map();

function send(response, status, value, type = "application/json; charset=utf-8") {
  response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  response.end(type.startsWith("application/json") ? JSON.stringify(value) : value);
}

function page() {
  const escape = (value) => String(value).replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
  const items = outbox.map((item) => `<article><small>${escape(item.at)} · ${escape(item.method)} · ${escape(item.chatId)}</small><pre>${escape(item.text || `${item.filename} · ${item.bytes} байт`)}</pre>${item.documentId ? `<a href="/document/${item.documentId}" download="${escape(item.filename)}">Скачать PDF</a>` : ""}</article>`).join("");
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Demeu · локальные уведомления</title><meta http-equiv="refresh" content="3"><style>body{font:16px system-ui;background:#f5f7f8;color:#17252c;max-width:850px;margin:3rem auto;padding:0 1rem}article{background:white;border:1px solid #d8e2e7;border-radius:12px;padding:1rem;margin:1rem 0}pre{white-space:pre-wrap;font:inherit}small{color:#60747e}</style><h1>Локальные уведомления врачу</h1><p>Вымышленные данные. В Telegram ничего не отправляется. Страница обновляется каждые 3 секунды.</p>${items || "<p>Пока пусто. Завершите опрос пациента.</p>"}</html>`;
}

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") return send(response, 200, { ok: true });
  if (request.method === "GET" && request.url === "/outbox") return send(response, 200, { outbox });
  if (request.method === "GET" && request.url === "/") return send(response, 200, page(), "text/html; charset=utf-8");
  if (request.method === "GET" && /^\/document\/[0-9]+$/u.test(request.url ?? "")) {
    const document = documents.get(Number(request.url.split("/").at(-1)));
    if (!document) return send(response, 404, { ok: false });
    response.writeHead(200, { "content-type": "application/pdf", "content-disposition": `attachment; filename="${document.filename}"`, "cache-control": "no-store" });
    response.end(document.pdf);
    return;
  }
  if (request.method !== "POST" || !/^\/botlocal-mock-token\/(sendMessage|sendDocument)$/u.test(request.url ?? "")) {
    return send(response, 404, { ok: false });
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const method = request.url.endsWith("sendMessage") ? "sendMessage" : "sendDocument";
  if (method === "sendMessage") {
    try {
      const payload = JSON.parse(body.toString("utf8"));
      if (typeof payload.chat_id !== "string" || typeof payload.text !== "string") throw new Error("Invalid message");
      outbox.push({ method, at: new Date().toISOString(), chatId: payload.chat_id, text: payload.text });
    } catch {
      return send(response, 400, { ok: false });
    }
  } else {
    const value = body.toString("latin1");
    const chatId = /name="chat_id"\r\n\r\n([^\r]+)/u.exec(value)?.[1] ?? "unknown";
    const filename = /name="document"; filename="([^"]+)"/u.exec(value)?.[1] ?? "summary.pdf";
    const start = body.indexOf(Buffer.from("%PDF-"));
    const endMarker = Buffer.from("%%EOF");
    const end = body.lastIndexOf(endMarker);
    if (start < 0 || end < start) return send(response, 400, { ok: false });
    const pdf = body.subarray(start, end + endMarker.length);
    const documentId = outbox.length + 1;
    documents.set(documentId, { filename, pdf });
    outbox.push({ method, at: new Date().toISOString(), chatId, filename, bytes: pdf.length, documentId });
  }
  return send(response, 200, { ok: true, result: { message_id: outbox.length } });
});

server.listen(port, "127.0.0.1", () => console.log(`mock Telegram ready on 127.0.0.1:${server.address().port}`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
