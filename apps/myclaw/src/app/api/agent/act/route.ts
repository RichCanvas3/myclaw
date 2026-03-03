export const runtime = "nodejs";

type ActRequest = {
  thread_id?: string | null;
  user_id?: string;
  org_id?: string;
  church_id?: string;
  person_id?: string;
  household_id?: string;
  message: string;
};

type SuggestedAction = {
  type: string;
  input?: Record<string, unknown>;
};

function langgraphDeploymentUrl(): string | null {
  return process.env.LANGGRAPH_DEPLOYMENT_URL ?? null;
}

function langgraphApiKey(): string | null {
  return process.env.LANGGRAPH_API_KEY ?? process.env.LANGSMITH_API_KEY ?? null;
}

function langgraphAssistantId(): string {
  return process.env.LANGGRAPH_ASSISTANT_ID ?? "myclaw_agent";
}

function a2aBaseUrl(): string {
  return (process.env.CHURCHCORE_A2A_BASE_URL ?? "https://a2a-gateway-worker.richardpedersen3.workers.dev/a2a/")
    .replace(/\/+$/, "")
    .concat("/");
}

function a2aApiKey(): string | null {
  return process.env.CHURCHCORE_A2A_API_KEY ?? null;
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function extractOutputMessage(v: unknown): string | null {
  // We look for any nested shape like { output: { message: string } }.
  const stack: unknown[] = [v];
  let steps = 0;
  while (stack.length && steps < 2000) {
    steps++;
    const cur = stack.pop();
    if (!cur) continue;

    if (Array.isArray(cur)) {
      for (const item of cur) stack.push(item);
      continue;
    }

    if (!isRecord(cur)) continue;

    const out = cur.output;
    if (isRecord(out) && typeof out.message === "string" && out.message.trim()) {
      return out.message;
    }

    for (const val of Object.values(cur)) stack.push(val);
  }
  return null;
}

function extractSuggestedActions(v: unknown): SuggestedAction[] | null {
  const stack: unknown[] = [v];
  let steps = 0;
  while (stack.length && steps < 2000) {
    steps++;
    const cur = stack.pop();
    if (!cur) continue;

    if (Array.isArray(cur)) {
      for (const item of cur) stack.push(item);
      continue;
    }

    if (!isRecord(cur)) continue;

    const sa = cur.suggestedActions;
    if (Array.isArray(sa)) {
      const parsed: SuggestedAction[] = [];
      for (const item of sa) {
        if (!isRecord(item)) continue;
        if (typeof item.type !== "string") continue;
        parsed.push({ type: item.type, input: isRecord(item.input) ? item.input : undefined });
      }
      return parsed;
    }

    for (const val of Object.values(cur)) stack.push(val);
  }
  return null;
}

function parseSseChunk(buffer: string): { events: Array<{ event: string; data: unknown }>; rest: string } {
  const events: Array<{ event: string; data: unknown }> = [];
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? "";

  for (const part of parts) {
    const lines = part.split(/\r?\n/);
    const eventLine = lines.find((l) => l.startsWith("event: "));
    const dataLine = lines.find((l) => l.startsWith("data: "));
    if (!eventLine || !dataLine) continue;

    const event = eventLine.slice("event: ".length).trim();
    const raw = dataLine.slice("data: ".length).trim();
    try {
      events.push({ event, data: JSON.parse(raw) as unknown });
    } catch {
      // ignore
    }
  }

  return { events, rest };
}

async function a2aChatStream(params: {
  endpoint: string;
  payload: Record<string, unknown>;
  onDelta: (text: string) => void;
}): Promise<void> {
  const key = a2aApiKey();
  if (!key) throw new Error("Missing CHURCHCORE_A2A_API_KEY");

  const res = await fetch(`${a2aBaseUrl()}${params.endpoint}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream, application/json",
      "x-api-key": key,
    },
    body: JSON.stringify(params.payload),
  });

  if (!res.ok || !res.body) {
    throw new Error(`A2A ${params.endpoint} failed: ${res.status} - ${await res.text()}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? "";
    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const raw = trimmed.slice("data:".length).trim();
      if (!raw) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(raw) as unknown;
      } catch {
        continue;
      }
      if (isRecord(obj)) {
        const delta = obj.delta;
        const text = obj.text;
        const message = obj.message;
        if (typeof delta === "string" && delta) params.onDelta(delta);
        else if (typeof text === "string" && text) params.onDelta(text);
        else if (typeof message === "string" && message) params.onDelta(message);
      }
    }
  }
}

async function a2aCallJson(endpoint: string, payload: Record<string, unknown>): Promise<unknown> {
  const key = a2aApiKey();
  if (!key) throw new Error("Missing CHURCHCORE_A2A_API_KEY");

  const res = await fetch(`${a2aBaseUrl()}${endpoint}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "x-api-key": key,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`A2A ${endpoint} failed: ${res.status} - ${text}`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function normalizeAction(action: SuggestedAction): { kind: "a2a.call"; endpoint: string; stream: boolean; payload: Record<string, unknown> } | null {
  if (action.type !== "a2a.call") return null;
  const input = action.input ?? {};
  const endpoint = typeof input.endpoint === "string" ? input.endpoint : null;
  const payload = isRecord(input.payload) ? input.payload : null;
  const streamFlag = input.stream;
  if (!endpoint || !payload) return null;
  const stream = (typeof streamFlag === "boolean" ? streamFlag : endpoint.endsWith(".stream")) || endpoint.endsWith(".stream");
  return { kind: "a2a.call", endpoint, stream, payload };
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as ActRequest;

  const deploymentUrl = langgraphDeploymentUrl();
  if (!deploymentUrl) {
    return new Response("Missing LANGGRAPH_DEPLOYMENT_URL", { status: 500 });
  }

  const apiKey = langgraphApiKey();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;

  // Ensure thread exists in LangGraph Agent Server.
  let threadId = body.thread_id ?? null;
  if (!threadId) {
    const tRes = await fetch(`${deploymentUrl}/threads`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    if (!tRes.ok) {
      return new Response(await tRes.text(), { status: tRes.status });
    }
    const tJson = (await tRes.json()) as { thread_id?: string };
    threadId = tJson.thread_id ?? null;
  }
  if (!threadId) return new Response("Failed to create thread", { status: 500 });

  const upstream = await fetch(`${deploymentUrl}/threads/${threadId}/runs/stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      assistant_id: langgraphAssistantId(),
      input: {
        skill: "chat",
        message: body.message,
        args: null,
        session: {
          churchId: body.church_id ?? body.org_id ?? "calvarybible",
          userId: body.user_id ?? "demo_user_noah",
          personId: body.person_id ?? "p_seeker_2",
          householdId: body.household_id ?? null,
          thread_id: threadId,
        },
      },
      stream_mode: ["custom", "updates"],
    }),
  });

  if (!upstream.ok || !upstream.body) {
    return new Response(await upstream.text(), { status: upstream.status });
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let accumulated = "";
  let fallbackMessage: string | null = null;
  let suggestedActions: SuggestedAction[] | null = null;
  let buffer = "";

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(sse("thread", { thread_id: threadId })));

      const reader = upstream.body!.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseChunk(buffer);
        buffer = parsed.rest;

        for (const ev of parsed.events) {
          if (ev.event === "error") {
            // Surface upstream errors to the UI.
            const msg =
              (isRecord(ev.data) && typeof ev.data.message === "string" && ev.data.message) ||
              JSON.stringify(ev.data);
            if (!accumulated) accumulated = msg;
            controller.enqueue(encoder.encode(sse("delta", { text: msg })));
            continue;
          }
          if (ev.event === "custom") {
            const data = ev.data as unknown;
            if (typeof data === "object" && data !== null && "delta" in data) {
              const delta = (data as { delta?: unknown }).delta;
              if (typeof delta === "string") {
                accumulated += delta;
                controller.enqueue(encoder.encode(sse("delta", { text: delta })));
              }
            }
            continue;
          }

          // If we didn't get any custom deltas, LangGraph often still provides output in updates.
          const maybe = extractOutputMessage(ev.data);
          if (maybe) fallbackMessage = maybe;

          const sa = extractSuggestedActions(ev.data);
          if (sa && sa.length) suggestedActions = sa;
        }
      }

      // Orchestrate: execute agent-suggested actions via Next.js (not from LangSmith runtime).
      // Default: if no actions were produced, fall back to whatever message we got.
      const session = {
        churchId: body.church_id ?? body.org_id ?? "calvarybible",
        userId: body.user_id ?? "demo_user_noah",
        personId: body.person_id ?? "p_seeker_2",
        householdId: body.household_id ?? null,
      };

      if (suggestedActions && suggestedActions.length) {
        for (const action of suggestedActions) {
          const norm = normalizeAction(action);
          if (!norm) continue;

          // Ensure session is always present for gateway calls.
          const payload: Record<string, unknown> = { ...norm.payload };
          payload.session = isRecord(payload.session) ? { ...session, ...payload.session } : session;

          try {
            if (norm.stream) {
              await a2aChatStream({
                endpoint: norm.endpoint,
                payload,
                onDelta: (t) => {
                  accumulated += t;
                  controller.enqueue(encoder.encode(sse("delta", { text: t })));
                },
              });
            } else {
              const resp = await a2aCallJson(norm.endpoint, payload);
              const rendered = typeof resp === "string" ? resp : JSON.stringify(resp, null, 2);
              accumulated ||= rendered;
              controller.enqueue(encoder.encode(sse("delta", { text: rendered })));
            }
          } catch (e) {
            const msg = `A2A error: ${(e as Error).message}`;
            accumulated ||= msg;
            controller.enqueue(encoder.encode(sse("delta", { text: msg })));
          }
        }
      } else if (accumulated.includes("A2A HTTP 403") || accumulated.includes("error code: 1010")) {
        // Back-compat: if the currently deployed agent still tries to call A2A from LangSmith
        // (and gets blocked), fall back to calling A2A from Next.js.
        accumulated = "";
        try {
          await a2aChatStream({
            endpoint: "chat.stream",
            payload: { skill: "chat", message: body.message, args: null, session },
            onDelta: (t) => {
              accumulated += t;
              controller.enqueue(encoder.encode(sse("delta", { text: t })));
            },
          });
        } catch (e) {
          const msg = `A2A error: ${(e as Error).message}`;
          accumulated ||= msg;
          controller.enqueue(encoder.encode(sse("delta", { text: msg })));
        }
      } else if (!accumulated.trim() && fallbackMessage) {
        accumulated = fallbackMessage;
        if (accumulated) controller.enqueue(encoder.encode(sse("delta", { text: accumulated })));
      }

      controller.enqueue(
        encoder.encode(
          sse("final", {
            thread_id: threadId,
            message: accumulated.trim(),
            entities: [],
            suggestedActions: [],
          }),
        ),
      );
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

