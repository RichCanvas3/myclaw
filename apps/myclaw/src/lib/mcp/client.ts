import { getMcpServer } from "@/lib/mcp/registry";

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

async function mcpRequest(serverId: string, req: JsonRpcRequest): Promise<unknown> {
  const server = getMcpServer(serverId);
  const res = await fetch(server.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      [server.apiKeyHeader]: server.apiKey,
    },
    body: JSON.stringify(req),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`MCP ${serverId} HTTP ${res.status}: ${text}`);
  const events = parseMcpSse(text);
  const result = extractJsonRpcResult(events);
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

