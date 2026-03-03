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
}): Promise<{ actions: SuggestedAction[] } | null> {
  if (!apiKey()) return null;

  const system = [
    "You are the planner for a personal assistant orchestrator.",
    "Return ONLY valid JSON.",
    "",
    "You may output actions in this form:",
    '- {"type":"mcp.tool","input":{"server":"gym-weather"|"gym-sendgrid","tool":"...","args":{...}}}',
    "",
    "Rules:",
    "- Only plan sendEmail/scheduleEmail when the user explicitly asks to send an email and provides the address.",
    "- For weather, use gym-weather tools. If lat/lon are unknown, ask a follow-up question by returning no actions and include a reply in compose stage.",
    "- Keep actions minimal (1-2).",
  ].join("\n");

  const user = JSON.stringify(
    {
      userMessage: params.userMessage,
      session: params.session,
      threadId: params.threadId,
      memoryProfile: params.memoryProfile,
      mcpServers: {
        "gym-weather": [
          "weather_current",
          "weather_forecast_hourly",
          "weather_forecast_daily",
          "weather_alerts",
        ],
        "gym-sendgrid": ["sendEmail", "scheduleEmail", "sendEmailWithTemplate"],
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
    "If tool results include weather JSON, summarize it nicely (current + next few hours).",
    "If tool results include SendGrid email sent, confirm success.",
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

