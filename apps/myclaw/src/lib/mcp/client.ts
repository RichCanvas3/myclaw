import { getMcpServer } from "@/lib/mcp/registry";
import { logMyclaw, summarizeMcpToolArgs } from "@/lib/observability";

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
};

function parseMcpSse(text: string): unknown[] {
  // The Workers MCP handler responds as SSE with `event: message` and `data: { ... }`.
  const events: unknown[] = [];
  const parts = text.split(/\r?\n\r?\n/);
  for (const part of parts) {
    const lines = part.split(/\r?\n/);
    const dataLine = lines.find((l) => l.startsWith("data: "));
    if (!dataLine) continue;
    const raw = dataLine.slice("data: ".length).trim();
    if (!raw) continue;
    try {
      events.push(JSON.parse(raw) as unknown);
    } catch {
      // ignore
    }
  }
  return events;
}

function extractJsonRpcResult(events: unknown[]): unknown {
  // Look for { result: ... } first; otherwise propagate { error }.
  for (const ev of events) {
    if (typeof ev !== "object" || ev === null) continue;
    const rec = ev as Record<string, unknown>;
    if ("result" in rec) return unwrapMcpResult(rec.result);
    if ("error" in rec) return rec;
  }
  return unwrapMcpResult(events[0] ?? null);
}

function unwrapMcpResult(v: unknown): unknown {
  // Tool calls usually return { content: [{ type: "text", text: "..." }, ...] }
  if (typeof v !== "object" || v === null) return v;
  const rec = v as Record<string, unknown>;
  const content = rec.content;
  if (!Array.isArray(content)) return v;
  const texts: string[] = [];
  for (const item of content) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (r.type === "text" && typeof r.text === "string") texts.push(r.text);
  }
  if (texts.length === 1) return texts[0];
  if (texts.length > 1) return texts.join("\n\n");
  return v;
}

export type McpRawResponse = {
  sessionId: string | null;
  events: unknown[];
  result: unknown;
};

async function mcpRequestRaw(
  serverId: string,
  req: JsonRpcRequest,
  opts?: { sessionId?: string | null },
): Promise<McpRawResponse> {
  const server = getMcpServer(serverId);
  const paramsRec = req.params && isRecord(req.params) ? req.params : null;
  const toolName =
    req.method === "tools/call" && paramsRec && typeof paramsRec.name === "string" ? String(paramsRec.name) : undefined;
  const toolArgs =
    toolName && paramsRec && isRecord(paramsRec.arguments) ? (paramsRec.arguments as Record<string, unknown>) : undefined;
  const resourceUri =
    paramsRec && typeof paramsRec.uri === "string" ? String(paramsRec.uri).slice(0, 120) : undefined;
  const started = Date.now();
  logMyclaw(
    "mcp",
    `→ ${serverId} ${req.method}${toolName ? ` ${toolName}` : resourceUri ? ` ${resourceUri}` : ""}`,
    {
      session: opts?.sessionId ? "sticky" : "new",
      args: toolName && toolArgs ? summarizeMcpToolArgs(toolName, toolArgs) : undefined,
    },
  );

  const res = await fetch(server.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      [server.apiKeyHeader]: server.apiKey,
      ...(opts?.sessionId ? { "mcp-session-id": opts.sessionId } : {}),
    },
    body: JSON.stringify(req),
  });

  const text = await res.text();
  const ms = Date.now() - started;
  if (!res.ok) {
    logMyclaw("mcp", `← ${serverId} HTTP ${res.status} ${ms}ms`, { tool: toolName });
    throw new Error(`MCP ${serverId} HTTP ${res.status}: ${text}`);
  }
  const sessionId = res.headers.get("mcp-session-id");
  const events = parseMcpSse(text);
  const result = extractJsonRpcResult(events);
  const errObj = typeof result === "object" && result !== null && "error" in result ? (result as { error?: { message?: string } }).error : null;
  if (errObj?.message) {
    logMyclaw("mcp", `← ${serverId} jsonrpc error ${ms}ms`, { tool: toolName, error: errObj.message });
  } else {
    logMyclaw("mcp", `← ${serverId} ok ${ms}ms`, { tool: toolName, sessionId: sessionId ?? undefined });
  }
  return { sessionId, events, result };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

async function mcpRequest(serverId: string, req: JsonRpcRequest): Promise<unknown> {
  const { result } = await mcpRequestRaw(serverId, req);
  return result;
}

export async function mcpToolsList(serverId: string): Promise<unknown> {
  return mcpRequest(serverId, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
}

export async function mcpToolsCall(serverId: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
  return mcpRequest(serverId, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: tool, arguments: args },
  });
}

export async function mcpResourcesList(serverId: string, opts?: { sessionId?: string | null }): Promise<McpRawResponse> {
  return mcpRequestRaw(serverId, { jsonrpc: "2.0", id: 1, method: "resources/list", params: {} }, opts);
}

export async function mcpResourcesSubscribe(
  serverId: string,
  uri: string,
  opts?: { sessionId?: string | null },
): Promise<McpRawResponse> {
  return mcpRequestRaw(serverId, { jsonrpc: "2.0", id: 1, method: "resources/subscribe", params: { uri } }, opts);
}

export async function mcpResourcesRead(
  serverId: string,
  uri: string,
  opts?: { sessionId?: string | null },
): Promise<McpRawResponse> {
  return mcpRequestRaw(serverId, { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri } }, opts);
}

