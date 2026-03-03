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

function langgraphDeploymentUrl(): string | null {
  return process.env.LANGGRAPH_DEPLOYMENT_URL ?? null;
}

function langgraphApiKey(): string | null {
  return process.env.LANGGRAPH_API_KEY ?? process.env.LANGSMITH_API_KEY ?? null;
}

function langgraphAssistantId(): string {
  return process.env.LANGGRAPH_ASSISTANT_ID ?? "myclaw_agent";
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function parseSseChunk(buffer: string): { events: Array<{ event: string; data: unknown }>; rest: string } {
  const events: Array<{ event: string; data: unknown }> = [];
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";

  for (const part of parts) {
    const lines = part.split("\n");
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
          if (ev.event !== "custom") continue;
          const data = ev.data as unknown;
          if (typeof data === "object" && data !== null && "delta" in data) {
            const delta = (data as { delta?: unknown }).delta;
            if (typeof delta === "string") {
              accumulated += delta;
              controller.enqueue(encoder.encode(sse("delta", { text: delta })));
            }
          }
        }
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

