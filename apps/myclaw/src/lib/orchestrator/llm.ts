import type { SuggestedAction } from "@/lib/agents/types";

type Session = {
  churchId: string;
  userId: string;
  personId: string;
  householdId?: string | null;
};

function apiKey(): string | null {
  return process.env.ORCH_OPENAI_API_KEY ?? null;
}

function baseUrl(): string {
  return (process.env.ORCH_OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
}

function model(): string {
  return process.env.ORCH_OPENAI_MODEL ?? "gpt-4o-mini";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function extractJsonObject(text: string): unknown {
  // Best-effort: find first {...} block.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const sliced = text.slice(start, end + 1);
  try {
    return JSON.parse(sliced) as unknown;
  } catch {
    return null;
  }
}

async function chatJson(system: string, user: string): Promise<unknown> {
  const key = apiKey();
  if (!key) return null;
  const url = `${baseUrl()}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: model(),
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${txt}`);
  const json = JSON.parse(txt) as unknown;
  const content =
    isRecord(json) &&
    Array.isArray(json.choices) &&
    isRecord(json.choices[0]) &&
    isRecord((json.choices[0] as Record<string, unknown>).message) &&
    typeof ((json.choices[0] as Record<string, unknown>).message as Record<string, unknown>).content === "string"
      ? (((json.choices[0] as Record<string, unknown>).message as Record<string, unknown>).content as string)
      : null;
  if (!content) return null;
  return extractJsonObject(content) ?? content;
}

export async function orchestratorPlan(params: {
  userMessage: string;
  session: Session;
  threadId: string;
  memoryProfile: unknown;
  nowISO: string;
}): Promise<{ actions: SuggestedAction[] } | null> {
  if (!apiKey()) return null;

  const system = [
    "You are the planner for a personal assistant orchestrator.",
    "Return ONLY valid JSON.",
    "",
    "You may output actions in this form:",
    '- {"type":"a2a.call","input":{"agent":"churchcore","endpoint":"...","stream":true|false,"payload":{...}}}',
    '- {"type":"mcp.tool","input":{"server":"gym-weather"|"gym-telegram","tool":"...","args":{...}}}',
    '- {"type":"calendar.range","input":{"accountAddress":"optional","timeMinISO":"...","timeMaxISO":"...","query":"optional"}}',
    '- {"type":"email.send","input":{"to":["a@b.com"],"subject":"optional","text":"optional","includeHousehold":true}}',
    '- {"type":"memory.upsert","input":{"namespace":"identity|household|community|bdi|goals|threads","key":"...","value":{...}}}',
    '- {"type":"memory.query","input":{"namespace":"...","q":"..."}}',
    "",
    "Examples:",
    '- User: "send email to richard@example.com that says hi" -> actions: [{"type":"email.send","input":{"to":["richard@example.com"],"subject":"Hi","text":"Hi"}}]',
    '- User: "what is the weather at (lat,lon)" -> actions: [{"type":"mcp.tool","input":{"server":"gym-weather","tool":"weather_current","args":{"lat":40.0,"lon":-105.2,"units":"imperial"}}}]',
    '- User: "send telegram to chatId 1234: hello" -> actions: [{"type":"mcp.tool","input":{"server":"gym-telegram","tool":"telegram_send_message","args":{"chatId":1234,"text":"hello"}}}]',
    '- User: "show my calendar for the next 2 months" -> actions: [{"type":"calendar.range","input":{"timeMinISO":"...","timeMaxISO":"..."}}]',
    "",
    "Rules:",
    "- For email: ALWAYS use email.send (do NOT call gym-sendgrid tools directly).",
    "- Only send email when the user explicitly asks to send and provides at least one email address.",
    "- If multiple recipients are provided, include all in email.send.input.to.",
    "- If the user asks to include household info, set email.send.input.includeHousehold=true AND include an a2a.call to churchcore endpoint 'household.get' before the email.send action.",
    "- For weather, use gym-weather tools. If no location is provided, omit lat/lon and the server will use the default location.",
    "- For Telegram, ALWAYS use gym-telegram tools when the user asks anything Telegram-related.",
    "- If the user asks to list messages and provides chatId, call telegram_list_messages with {chatId, limit} (default limit=20).",
    "- If the user asks to list messages and provides a chat title (e.g. 'Smart Agent') but not chatId, call telegram_list_messages with {chatTitle:\"Smart Agent\", limit}. The server will resolve chatTitle to chatId.",
    "- If the user asks to list chats, call telegram_list_chats.",
    "- If the user asks to search messages, call telegram_search_messages with {q, chatId?: optional, limit?: optional}.",
    "- If the user asks to send a message, call telegram_send_message with {chatId, text}.",
    "- If the user asks to send a message by chat title, call telegram_send_message with {chatTitle, text}. The server will resolve chatTitle to chatId.",
    "- If the user asks to edit/delete/pin, call telegram_edit_message_text / telegram_delete_message / telegram_pin_message (requires messageId and permissions).",
    "- If chatId is missing, first call telegram_list_chats OR ask the user for chatId.",
    "- For calendar: ALWAYS use calendar.range (do NOT call googlecalendar_* tools directly).",
    "- Use nowISO as the current time anchor.",
    "- If the user asks for 'my calendar' without dates, default to [nowISO, nowISO+30d).",
    "- For multi-month requests (e.g. 'next 3 months'), set timeMaxISO appropriately.",
    "- Use ISO strings; timeMinISO is inclusive, timeMaxISO is exclusive.",
    "- calendar.range accountAddress is optional. If omitted, the server will use its default acct_... identity.",
    "- For Churchcore household sync: plan a2a.call household.get (or household.identify then household.get) AND a memory.upsert into namespace=household.",
    "- Keep actions minimal (1-4).",
  ].join("\n");

  const user = JSON.stringify(
    {
      userMessage: params.userMessage,
      session: params.session,
      threadId: params.threadId,
      memoryProfile: params.memoryProfile,
      nowISO: params.nowISO,
      mcpServers: {
        "gym-weather": [
          "weather_current",
          "weather_forecast_hourly",
          "weather_forecast_daily",
          "weather_alerts",
        ],
        "gym-sendgrid": ["sendEmail", "scheduleEmail", "sendEmailWithTemplate"],
        "gym-googlecalendar": [
          "googlecalendar_get_connection_status",
          "googlecalendar_freebusy",
          "googlecalendar_list_events",
          "googlecalendar_create_event",
        ],
        "gym-telegram": [
          "telegram_ping",
          "telegram_set_webhook",
          "telegram_get_webhook_info",
          "telegram_send_message",
          "telegram_edit_message_text",
          "telegram_delete_message",
          "telegram_pin_message",
          "telegram_list_chats",
          "telegram_list_messages",
          "telegram_search_messages",
          "telegram_create_group"
        ],
      },
    },
    null,
    2,
  );

  const out = await chatJson(system, user);
  if (!isRecord(out) || !Array.isArray(out.actions)) return { actions: [] };

  const actions: SuggestedAction[] = [];
  for (const a of out.actions) {
    if (!isRecord(a) || typeof a.type !== "string") continue;
    actions.push(a as SuggestedAction);
  }
  return { actions };
}

export async function orchestratorCompose(params: {
  userMessage: string;
  session: Session;
  threadId: string;
  toolResults: Array<{ action: SuggestedAction; result: unknown }>;
}): Promise<string> {
  if (!apiKey()) {
    // No LLM: dump tool results.
    return JSON.stringify({ toolResults: params.toolResults }, null, 2);
  }

  const system = [
    "You are the response writer for a personal assistant.",
    "Use the tool results to answer the user. Be concise and helpful.",
    "Never claim a tool action happened unless it appears in toolResults.",
    "If tool results include weather JSON, summarize it nicely (current + next few hours).",
    "If tool results include calendar events for a large range, summarize by month and highlight busy days and key events.",
    "If tool results include SendGrid email sent, confirm success.",
    "If an email was sent and household data was requested, briefly confirm the household info was included (e.g. list member names).",
    "If tool results include Telegram actions, summarize what happened (e.g. message sent to chatId, edited/deleted/pinned, webhook set, chats/messages listed).",
    "Return ONLY JSON: {\"text\": \"...\"}.",
  ].join("\n");

  const user = JSON.stringify(
    {
      userMessage: params.userMessage,
      session: params.session,
      threadId: params.threadId,
      toolResults: params.toolResults,
    },
    null,
    2,
  );

  const out = await chatJson(system, user);
  if (isRecord(out) && typeof out.text === "string") return out.text;
  if (typeof out === "string") return out;
  return JSON.stringify(out, null, 2);
}

export async function orchestratorComposeEmail(params: {
  userMessage: string;
  session: Session;
  threadId: string;
  to: string[];
  subjectHint?: string;
  textHint?: string;
  includeHousehold?: boolean;
  toolResults: Array<{ action: SuggestedAction; result: unknown }>;
}): Promise<{ subject: string; text: string; html?: string }> {
  if (!apiKey()) {
    const subject = params.subjectHint ?? "Message from myclaw";
    const text = params.textHint ?? params.userMessage;
    return { subject, text };
  }

  const system = [
    "You draft an outbound email for a personal assistant.",
    "Use the toolResults (especially household.get) when includeHousehold is true.",
    "Return ONLY JSON: {\"subject\":\"...\",\"text\":\"...\",\"html\":\"optional\"}.",
    "Do not fabricate household details; only use what is present in toolResults.",
  ].join("\n");

  const user = JSON.stringify(
    {
      userMessage: params.userMessage,
      session: params.session,
      threadId: params.threadId,
      to: params.to,
      subjectHint: params.subjectHint ?? null,
      textHint: params.textHint ?? null,
      includeHousehold: params.includeHousehold ?? false,
      toolResults: params.toolResults,
    },
    null,
    2,
  );

  const out = await chatJson(system, user);
  if (typeof out === "object" && out !== null) {
    const rec = out as Record<string, unknown>;
    const subject = typeof rec.subject === "string" && rec.subject.trim() ? rec.subject.trim() : "Message from myclaw";
    const text = typeof rec.text === "string" && rec.text.trim() ? rec.text : JSON.stringify(out, null, 2);
    const html = typeof rec.html === "string" && rec.html.trim() ? rec.html : undefined;
    return { subject, text, ...(html ? { html } : {}) };
  }
  return { subject: params.subjectHint ?? "Message from myclaw", text: String(out ?? "") };
}

