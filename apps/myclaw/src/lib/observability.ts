/**
 * Structured console logging for debugging MCP / Telegram / goal flows.
 *
 * Enable: MYCLAW_DEBUG=1 or MYCLAW_MCP_LOG=1 (any non-production default is ON when unset).
 * Disable noise: MYCLAW_DEBUG=0
 */

export function observabilityEnabled(): boolean {
  const d = (process.env.MYCLAW_DEBUG ?? "").trim().toLowerCase();
  if (d === "0" || d === "false" || d === "off" || d === "no") return false;
  if (d === "1" || d === "true" || d === "on" || d === "yes") return true;
  const m = (process.env.MYCLAW_MCP_LOG ?? "").trim().toLowerCase();
  if (m === "0" || m === "false" || m === "off" || m === "no") return false;
  if (m === "1" || m === "true" || m === "on" || m === "yes") return true;
  return process.env.NODE_ENV !== "production";
}

export function logMyclaw(scope: string, message: string, data?: Record<string, unknown>): void {
  if (!observabilityEnabled()) return;
  const tag = `[myclaw:${scope}]`;
  if (data && Object.keys(data).length > 0) console.log(tag, message, data);
  else console.log(tag, message);
}

/** Shrink MCP tool args for logs (never dump raw image bytes). */
export function summarizeMcpToolArgs(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const scope = args.scope;
  const scopeHint =
    typeof scope === "object" && scope !== null
      ? {
          churchId: typeof (scope as Record<string, unknown>).churchId === "string" ? (scope as Record<string, unknown>).churchId : undefined,
          userId: typeof (scope as Record<string, unknown>).userId === "string" ? (scope as Record<string, unknown>).userId : undefined,
          personId: typeof (scope as Record<string, unknown>).personId === "string" ? (scope as Record<string, unknown>).personId : undefined,
        }
      : {};

  if (tool === "weight_analyze_meal_photo") {
    const tg = args.telegram;
    const tgr = typeof tg === "object" && tg !== null ? (tg as Record<string, unknown>) : null;
    const b64 = typeof args.imageBase64 === "string" ? args.imageBase64.length : 0;
    return {
      ...scopeHint,
      imageBase64_chars: b64,
      has_imageUrl: typeof args.imageUrl === "string" && args.imageUrl.length > 0,
      telegram_fileId: typeof tgr?.fileId === "string" ? `${String(tgr.fileId).slice(0, 14)}…` : undefined,
      telegram_chatId: typeof tgr?.chatId === "string" ? tgr.chatId : undefined,
      telegram_messageId: typeof tgr?.messageId === "number" ? tgr.messageId : undefined,
    };
  }

  if (tool === "telegram_list_messages" || tool === "telegram_send_message") {
    return {
      ...scopeHint,
      chatId: args.chatId,
      chatTitle: args.chatTitle,
      limit: args.limit,
      text_len: typeof args.text === "string" ? args.text.length : undefined,
    };
  }

  const keys = Object.keys(args).filter((k) => k !== "scope");
  return { ...scopeHint, argKeys: keys.slice(0, 16), argCount: keys.length };
}
