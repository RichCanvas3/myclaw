/**
 * Copy into your gym-telegram-mcp Worker (this repo does not contain that worker).
 * Logs JSON-RPC method + tool name + resource URI without dumping message bodies.
 */

export interface TelegramMcpEnv {
  TELEGRAM_MCP_LOG?: string;
}

function tgMcpLogEnabled(env: TelegramMcpEnv): boolean {
  const v = (env.TELEGRAM_MCP_LOG ?? "").trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off") return false;
  return true;
}

function tgMcpLog(env: TelegramMcpEnv, event: string, detail?: Record<string, unknown>): void {
  if (!tgMcpLogEnabled(env)) return;
  const extra = detail && Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : "";
  console.log(`[telegram-mcp] ${event}${extra}`);
}

/** Example: call from your MCP POST handler after parsing JSON body. */
export function logTelegramMcpJsonRpc(
  env: TelegramMcpEnv,
  body: { method?: string; params?: Record<string, unknown> },
): void {
  const method = typeof body.method === "string" ? body.method : "";
  const params = body.params && typeof body.params === "object" ? body.params : {};
  const tool = typeof params.name === "string" ? params.name : undefined;
  const uri = typeof params.uri === "string" ? params.uri.slice(0, 120) : undefined;
  tgMcpLog(env, "jsonrpc", { method, tool, uri });
}
