/**
 * Structured console logging for debugging MCP / Telegram / goal flows.
 *
 * Enable: MYCLAW_DEBUG=1 or MYCLAW_MCP_LOG=1 (any non-production default is ON when unset).
 * Disable noise: MYCLAW_DEBUG=0
 */

import { telegramFileIdLooksPlaceholder } from "@/lib/telegram/photoFileId";

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

/** Classify imageUrl for logs only — never log token-bearing Telegram file URLs. */
export function imageUrlKindForLog(url: unknown): "telegram_cdn" | "https" | "none" {
  if (typeof url !== "string" || !url.trim()) return "none";
  if (/api\.telegram\.org\/file\/bot/i.test(url)) return "telegram_cdn";
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? "https" : "none";
  } catch {
    return "none";
  }
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
    const urlKind = imageUrlKindForLog(args.imageUrl);
    const fidRaw = typeof tgr?.fileId === "string" ? String(tgr.fileId).trim() : "";
    const myclawToken = Boolean((process.env.MYCLAW_TELEGRAM_BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN ?? "").trim());
    let meal_photo_path: string;
    if (urlKind !== "none") meal_photo_path = "myclaw_imageUrl";
    else if (b64 > 0) meal_photo_path = "base64";
    else if (fidRaw) meal_photo_path = myclawToken ? "unexpected_no_url" : "worker_telegram_fileId";
    else meal_photo_path = "missing";
    return {
      ...scopeHint,
      imageBase64_chars: b64,
      imageUrl_kind: urlKind,
      meal_photo_path,
      fileId_len: fidRaw ? fidRaw.length : undefined,
      fileId_suspect_placeholder: fidRaw ? telegramFileIdLooksPlaceholder(fidRaw) : undefined,
      telegram_fileId: fidRaw ? `${fidRaw.slice(0, 14)}…` : undefined,
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
