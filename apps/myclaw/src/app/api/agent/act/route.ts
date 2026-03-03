import { getA2aAgent } from "@/lib/agents/registry";
import type { SuggestedAction } from "@/lib/agents/types";
import { mcpToolsCall, mcpToolsList } from "@/lib/mcp/client";
import { orchestratorCompose, orchestratorPlan } from "@/lib/orchestrator/llm";
import { memoryAppendEvent, memoryGet, memoryGetProfile, memoryQuery, memoryUpsert } from "@/lib/memory/client";

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

function extractDeltaLike(obj: unknown): string | null {
  // Common shapes:
  // - {"delta":"..."} / {"text":"..."} / {"message":"..."}
  // - {"data":{"delta":"..."}} etc.
  const stack: unknown[] = [obj];
  let steps = 0;
  while (stack.length && steps < 2000) {
    steps++;
    const cur = stack.pop();
    if (!cur) continue;
    if (typeof cur === "string" && cur.trim()) return cur;
    if (Array.isArray(cur)) {
      for (const it of cur) stack.push(it);
      continue;
    }
    if (!isRecord(cur)) continue;
    for (const k of ["delta", "text", "message", "content"]) {
      const v = cur[k];
      if (typeof v === "string" && v.trim()) return v;
    }
    for (const v of Object.values(cur)) stack.push(v);
  }
  return null;
}

async function a2aChatStream(params: {
  agent: string | undefined;
  endpoint: string;
  payload: Record<string, unknown>;
  onDelta: (text: string) => void;
}): Promise<void> {
  const agent = getA2aAgent(params.agent);

  const res = await fetch(`${agent.baseUrl}${params.endpoint}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream, application/json",
      [agent.apiKeyHeader]: agent.apiKey,
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
        const t = extractDeltaLike(obj);
        if (t) params.onDelta(t);
      }
    }
  }
}

async function a2aCallJson(params: {
  agent: string | undefined;
  endpoint: string;
  payload: Record<string, unknown>;
}): Promise<unknown> {
  const agent = getA2aAgent(params.agent);

  const res = await fetch(`${agent.baseUrl}${params.endpoint}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      [agent.apiKeyHeader]: agent.apiKey,
    },
    body: JSON.stringify(params.payload),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`A2A ${params.endpoint} failed: ${res.status} - ${text}`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function normalizeAction(action: SuggestedAction): { kind: "a2a.call"; agent?: string; endpoint: string; stream: boolean; payload: Record<string, unknown> } | null {
  if (action.type !== "a2a.call") return null;
  const input = action.input;
  const endpoint = typeof input?.endpoint === "string" ? input.endpoint : null;
  const payload = isRecord(input?.payload) ? input.payload : null;
  const streamFlag = input?.stream;
  const agent = typeof input?.agent === "string" ? input.agent : undefined;
  if (!endpoint || !payload) return null;
  const stream =
    (typeof streamFlag === "boolean" ? streamFlag : endpoint.endsWith(".stream")) ||
    endpoint.endsWith(".stream");
  return { kind: "a2a.call", agent, endpoint, stream, payload };
}

async function ensureA2aThread(params: {
  agent: string | undefined;
  session: { churchId: string; userId: string; personId: string; householdId?: string | null };
  ctx: { churchId: string; userId: string; personId: string; householdId?: string | null; threadId: string };
}): Promise<string> {
  const agentId = params.agent ?? "churchcore";
  const mapKey = `a2a:${agentId}:${params.ctx.threadId}`;

  const existing = await memoryGet({ ctx: params.ctx, namespace: "threads", key: mapKey });
  if (isRecord(existing) && isRecord(existing.value) && typeof existing.value.thread_id === "string") {
    return existing.value.thread_id;
  }

  // Create A2A thread (best-effort). If memory isn’t configured, this will still work
  // for the current request but won’t persist across server restarts.
  const identity = {
    tenant_id: params.session.churchId,
    user_id: params.session.userId,
    person_id: params.session.personId,
    household_id: params.session.householdId ?? null,
  };
  const payload = { identity, title: `myclaw:${agentId}` };

  const resp = await a2aCallJson({ agent: agentId, endpoint: "thread.create", payload });
  const tid = isRecord(resp) && typeof resp.thread_id === "string" ? resp.thread_id : null;
  if (!tid) throw new Error("Failed to create A2A thread");

  try {
    await memoryUpsert({ ctx: params.ctx, namespace: "threads", key: mapKey, value: { thread_id: tid } });
  } catch {
    // ignore (memory not configured or transient error)
  }

  return tid;
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

  // Shortcut: allow direct MCP calls from the UI without needing a redeploy of the LangSmith director.
  // Format:
  // - /mcp <server> <tool> [<json_args>]
  // - /mcp-tools <server>
  const direct = body.message?.trim?.() ?? "";
  if (direct.startsWith("/mcp-tools ")) {
    const server = direct.replace("/mcp-tools ", "").trim();
    const encoder = new TextEncoder();
    const out = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(sse("thread", { thread_id: threadId })));
        try {
          const res = await mcpToolsList(server);
          const rendered = typeof res === "string" ? res : JSON.stringify(res, null, 2);
          controller.enqueue(encoder.encode(sse("delta", { text: rendered })));
          controller.enqueue(
            encoder.encode(sse("final", { thread_id: threadId, message: rendered, entities: [], suggestedActions: [] })),
          );
        } catch (e) {
          const msg = `MCP error: ${(e as Error).message}`;
          controller.enqueue(encoder.encode(sse("delta", { text: msg })));
          controller.enqueue(
            encoder.encode(sse("final", { thread_id: threadId, message: msg, entities: [], suggestedActions: [] })),
          );
        }
        controller.close();
      },
    });
    return new Response(out, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    });
  }

  if (direct.startsWith("/mcp ")) {
    const rest = direct.replace("/mcp ", "").trim();
    const [server, tool, ...argsParts] = rest.split(" ");
    const argsText = argsParts.join(" ").trim() || "{}";
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(argsText) as unknown;
      if (isRecord(parsed)) args = parsed;
    } catch {
      // ignore
    }
    const encoder = new TextEncoder();
    const out = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(sse("thread", { thread_id: threadId })));
        try {
          const res = await mcpToolsCall(server ?? "", tool ?? "", args);
          const rendered = typeof res === "string" ? res : JSON.stringify(res, null, 2);
          controller.enqueue(encoder.encode(sse("delta", { text: rendered })));
          controller.enqueue(
            encoder.encode(sse("final", { thread_id: threadId, message: rendered, entities: [], suggestedActions: [] })),
          );
        } catch (e) {
          const msg = `MCP error: ${(e as Error).message}`;
          controller.enqueue(encoder.encode(sse("delta", { text: msg })));
          controller.enqueue(
            encoder.encode(sse("final", { thread_id: threadId, message: msg, entities: [], suggestedActions: [] })),
          );
        }
        controller.close();
      },
    });
    return new Response(out, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    });
  }

  const session = {
    churchId: body.church_id ?? body.org_id ?? "calvarybible",
    userId: body.user_id ?? "demo_user_noah",
    personId: body.person_id ?? "p_seeker_2",
    householdId: body.household_id ?? null,
  };

  // Load durable memory profile (if configured). This is *not* stored in LangSmith.
  let memoryProfile: unknown = null;
  try {
    memoryProfile = await memoryGetProfile({ ...session, threadId });
  } catch {
    memoryProfile = null;
  }

  // If configured, use an orchestrator LLM to produce action packs (no phrase triggers).
  // Otherwise we fall back to the LangSmith director behavior below.
  const planned = await orchestratorPlan({
    userMessage: body.message,
    session,
    threadId,
    memoryProfile,
  });

  if (planned) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(sse("thread", { thread_id: threadId })));

        const toolResults: Array<{ action: SuggestedAction; result: unknown }> = [];
        let accumulated = "";

        for (const action of planned.actions) {
          if (action.type === "mcp.tool" && isRecord(action.input)) {
            const server = typeof action.input.server === "string" ? action.input.server : "";
            const tool = typeof action.input.tool === "string" ? action.input.tool : "";
            const args = isRecord(action.input.args) ? action.input.args : {};
            try {
              const res = await mcpToolsCall(server, tool, args);
              toolResults.push({ action, result: res });
            } catch (e) {
              toolResults.push({ action, result: { error: (e as Error).message } });
            }
            continue;
          }
          if (action.type === "a2a.call") {
            // Let existing A2A executor handle these by reusing the normal flow below.
            toolResults.push({ action, result: { skipped: true, reason: "a2a.call not supported in llm-orchestrator path yet" } });
            continue;
          }
          if (action.type === "memory.upsert" || action.type === "memory.query") {
            // Reuse existing handlers by pushing into results; compose step can still mention.
            toolResults.push({ action, result: { skipped: true, reason: "memory.* not supported in llm-orchestrator path yet" } });
            continue;
          }
        }

        try {
          const finalText = await orchestratorCompose({
            userMessage: body.message,
            session,
            threadId,
            toolResults,
          });
          accumulated = finalText;
          controller.enqueue(encoder.encode(sse("delta", { text: finalText })));
        } catch (e) {
          const msg = `Orchestrator error: ${(e as Error).message}`;
          accumulated = msg;
          controller.enqueue(encoder.encode(sse("delta", { text: msg })));
        }

        controller.enqueue(
          encoder.encode(
            sse("final", {
              thread_id: threadId,
              message: accumulated.trim(),
              entities: [],
              suggestedActions: planned.actions,
            }),
          ),
        );
        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    });
  }

  const upstream = await fetch(`${deploymentUrl}/threads/${threadId}/runs/stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      assistant_id: langgraphAssistantId(),
      input: {
        skill: "chat",
        message: body.message,
        args: { memory_profile: memoryProfile },
        session: {
          ...session,
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
  const executedActions: SuggestedAction[] = [];
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
      const ctx = { ...session, threadId };

      if (suggestedActions && suggestedActions.length) {
        for (const action of suggestedActions) {
          executedActions.push(action);

          if (action.type === "mcp.tool" && isRecord(action.input)) {
            try {
              const server = typeof action.input.server === "string" ? action.input.server : null;
              const tool = typeof action.input.tool === "string" ? action.input.tool : null;
              const args = isRecord(action.input.args) ? action.input.args : null;
              if (!server || !tool || !args) throw new Error("Invalid mcp.tool action");
              const resp = await mcpToolsCall(server, tool, args);
              const rendered = typeof resp === "string" ? resp : JSON.stringify(resp, null, 2);
              accumulated ||= rendered;
              controller.enqueue(encoder.encode(sse("delta", { text: rendered })));
            } catch (e) {
              const msg = `MCP error: ${(e as Error).message}`;
              accumulated ||= msg;
              controller.enqueue(encoder.encode(sse("delta", { text: msg })));
            }
            continue;
          }

          // Durable memory actions (executed by Next.js).
          if (action.type === "memory.upsert" && isRecord(action.input)) {
            try {
              const ns = typeof action.input.namespace === "string" ? action.input.namespace : null;
              const key = typeof action.input.key === "string" ? action.input.key : null;
              if (ns && key) {
                await memoryUpsert({ ctx, namespace: ns, key, value: action.input.value });
                controller.enqueue(encoder.encode(sse("delta", { text: `Saved to memory: ${ns}.${key}` })));
              }
            } catch (e) {
              controller.enqueue(encoder.encode(sse("delta", { text: `Memory error: ${(e as Error).message}` })));
            }
            continue;
          }
          if (action.type === "memory.query" && isRecord(action.input)) {
            try {
              const ns = typeof action.input.namespace === "string" ? action.input.namespace : undefined;
              const q = typeof action.input.q === "string" ? action.input.q : undefined;
              const resp = await memoryQuery({ ctx, namespace: ns, q, limit: 25 });
              const rendered = JSON.stringify(resp, null, 2);
              accumulated ||= rendered;
              controller.enqueue(encoder.encode(sse("delta", { text: rendered })));
            } catch (e) {
              controller.enqueue(encoder.encode(sse("delta", { text: `Memory error: ${(e as Error).message}` })));
            }
            continue;
          }

          const norm = normalizeAction(action);
          if (!norm) continue;

          // Ensure session is always present for gateway calls.
          const payload: Record<string, unknown> = { ...norm.payload };
          payload.session = isRecord(payload.session) ? { ...session, ...payload.session } : session;
          // Churchcore gateway expects these top-level fields for many skills.
          // A2A thread_id is *not* the LangSmith thread id; we map and persist it in memory.
          let a2aThreadId: string | null = null;
          try {
            a2aThreadId = await ensureA2aThread({ agent: norm.agent, session, ctx: { ...ctx, threadId } });
          } catch {
            a2aThreadId = null;
          }
          if (a2aThreadId) payload.thread_id ??= a2aThreadId;
          payload.identity ??= {
            tenant_id: session.churchId,
            user_id: session.userId,
            person_id: session.personId,
            household_id: session.householdId,
          };

          try {
            if (norm.stream) {
              const before = accumulated.length;
              await a2aChatStream({
                agent: norm.agent,
                endpoint: norm.endpoint,
                payload,
                onDelta: (t) => {
                  accumulated += t;
                  controller.enqueue(encoder.encode(sse("delta", { text: t })));
                },
              });
              // If streaming produced nothing, fall back to non-stream endpoint.
              if (accumulated.length === before && norm.endpoint.endsWith(".stream")) {
                const fallbackEndpoint = norm.endpoint.replace(/\.stream$/, "");
                const resp = await a2aCallJson({ agent: norm.agent, endpoint: fallbackEndpoint, payload });
                const rendered = typeof resp === "string" ? resp : JSON.stringify(resp, null, 2);
                accumulated ||= rendered;
                controller.enqueue(encoder.encode(sse("delta", { text: rendered })));
              }
            } else {
              const resp = await a2aCallJson({
                agent: norm.agent,
                endpoint: norm.endpoint,
                payload,
              });
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
            agent: "churchcore",
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
            suggestedActions: executedActions,
          }),
        ),
      );
      controller.close();

      // Audit trail (best-effort).
      try {
        await memoryAppendEvent({
          ctx,
          type: "orchestrator.run",
          payload: {
            threadId,
            input: { message: body.message },
            suggestedActions: suggestedActions ?? [],
            output: { message: accumulated.trim() },
          },
        });
      } catch {
        // ignore
      }
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

