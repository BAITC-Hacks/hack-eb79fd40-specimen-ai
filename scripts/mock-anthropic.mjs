import http from "node:http";

const port = Number(process.env.MOCK_PORT ?? 0);

function anthropicMessage(text, model = "claude-sonnet-5") {
  return {
    id: `msg_mock_${Date.now()}`,
    container: null,
    content: [{ type: "text", text, citations: null }],
    model,
    role: "assistant",
    stop_details: null,
    stop_reason: "end_turn",
    stop_sequence: null,
    type: "message",
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      inference_geo: "local-mock",
      input_tokens: 42,
      output_tokens: Math.max(1, text.length),
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: "standard",
    },
  };
}

function identifyScenario(text) {
  if (/поясниц/iu.test(text)) return "back-pain";
  if (/насморк|чих/iu.test(text)) return "rhinitis";
  if (/груд|одышк|задыха/iu.test(text)) return "chest-pain";
  return "unknown";
}

function analysisFor(scenario, messages) {
  if (scenario === "chest-pain") {
    return {
      anamnesis: {
        chief_complaint: "давящая боль в груди и одышка в покое",
        symptom: {
          onset: "сегодня",
          location: "грудная клетка",
          quality: "давящая",
          severity: 8,
          modifiers: "не указаны",
          associated: ["одышка в покое"],
        },
        past_history: [],
        chronic: [],
        allergies: [],
        medications: [],
        context: {
          age: 58,
          sex: "m",
          pregnancy: "na",
          risk_factors: [],
        },
      },
      evidence: {
        evidences: [{ code: "E_14" }, { code: "E_66" }],
        age: 58,
        sex: "m",
      },
      unmapped: [],
    };
  }

  if (scenario === "back-pain") {
    return {
      anamnesis: {
        chief_complaint: "ноющая боль в пояснице две недели",
        symptom: {
          onset: "две недели назад",
          location: "поясница",
          quality: "ноющая",
          severity: 4,
          modifiers: "к вечеру сильнее",
          associated: [],
        },
        past_history: [],
        chronic: [],
        allergies: [],
        medications: [],
        context: {
          age: 34,
          sex: "f",
          pregnancy: "na",
          risk_factors: [],
        },
      },
      evidence: {
        evidences: [{ code: "E_55", value: "V_40" }],
        age: 34,
        sex: "f",
      },
      unmapped: [],
    };
  }

  if (scenario === "rhinitis") {
    return {
      anamnesis: {
        chief_complaint: "насморк и чихание один день",
        symptom: {
          onset: "вчера",
          location: "нос",
          quality: "насморк",
          severity: 2,
          modifiers: "не указаны",
          associated: ["чихание"],
        },
        past_history: [],
        chronic: [],
        allergies: [],
        medications: [],
        context: {
          age: 27,
          sex: "m",
          pregnancy: "na",
          risk_factors: [],
        },
      },
      evidence: {
        evidences: [{ code: "E_181" }],
        age: 27,
        sex: "m",
      },
      unmapped: [],
    };
  }

  return {
    anamnesis: {
      chief_complaint: messages.find((message) => message?.role === "user" && typeof message.content === "string")?.content.slice(0, 500) ?? "Жалоба не описана",
      symptom: { onset: "не указано", location: "не указано", quality: "не указано", severity: null, modifiers: "не указаны", associated: [] },
      past_history: [], chronic: [], allergies: [], medications: [],
      context: { age: null, sex: "unknown", pregnancy: "na", risk_factors: [] },
    },
    evidence: { evidences: [], age: null, sex: "unknown" },
    unmapped: [],
  };
}

function chatReply(scenario, userTurns) {
  if (scenario === "chest-pain") {
    return [
      "Пожалуйста, немедленно позвоните 103 или обратитесь в приёмный покой.",
      "Сохраняйте спокойствие: данные уже переданы врачу.",
      "[ANAMNESIS_COMPLETE]",
    ].join("\n");
  }
  if (scenario === "back-pain") {
    if (userTurns === 1) return "Есть ли температура, онемение ног или нарушения мочеиспускания?";
    if (userTurns === 2) return "Есть ли хронические состояния, постоянные лекарства или аллергии?";
  }
  if (scenario === "rhinitis" && userTurns === 1) {
    return "Есть ли температура, боль в горле или другие жалобы?";
  }
  if (scenario === "unknown" && userTurns === 1) {
    return "Когда начались жалобы и что беспокоит сильнее всего?";
  }
  if (scenario === "unknown" && userTurns === 2) {
    return "Есть ли другие симптомы, хронические состояния, лекарства или аллергии?";
  }
  return "Спасибо, я передаю данные врачу.\n[ANAMNESIS_COMPLETE]";
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/messages") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ type: "error", error: { type: "not_found_error" } }));
    return;
  }

  try {
    const body = await readJson(request);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (messages.length === 0 || messages[0]?.role !== "user") {
      throw new Error("Anthropic history must start with a user message");
    }
    const transcript = messages
      .map((item) => typeof item?.content === "string" ? item.content : "")
      .join("\n");
    const scenario = identifyScenario(transcript);
    const structured = body.output_config?.format?.type === "json_schema";
    const userTurns = messages.filter((item) => item?.role === "user").length;
    const answer = structured
      ? JSON.stringify(analysisFor(scenario, messages))
      : chatReply(scenario, userTurns);

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(anthropicMessage(answer, body.model)));
  } catch (error) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: error instanceof Error ? error.message : String(error),
      },
    }));
  }
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  console.log(`mock Anthropic ready on 127.0.0.1:${boundPort}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
