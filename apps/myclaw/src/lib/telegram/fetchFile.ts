/**
 * Download a Telegram file by file_id using the Bot API (Next.js server only).
 * Used to pass imageBase64 to weight-management-mcp so the worker does not need TELEGRAM_BOT_TOKEN.
 */

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024; // 8 MiB — keep MCP JSON payloads reasonable

export async function fetchTelegramFileAsBase64(
  botToken: string,
  fileId: string,
  maxBytes: number = DEFAULT_MAX_BYTES,
): Promise<string> {
  const token = botToken.trim();
  const fid = fileId.trim();
  if (!token || !fid) throw new Error("telegram: missing bot token or fileId");

  const getFileUrl = new URL(`https://api.telegram.org/bot${token}/getFile`);
  getFileUrl.searchParams.set("file_id", fid);
  const getRes = await fetch(getFileUrl.toString());
  const getJson = (await getRes.json()) as {
    ok?: boolean;
    result?: { file_path?: string };
    description?: string;
  };
  if (!getJson.ok || !getJson.result?.file_path) {
    throw new Error(getJson.description ?? "telegram getFile failed");
  }
  const filePath = getJson.result.file_path;
  const fileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const bin = await fetch(fileUrl);
  if (!bin.ok) throw new Error(`telegram file download HTTP ${bin.status}`);
  const buf = Buffer.from(await bin.arrayBuffer());
  if (buf.length > maxBytes) {
    throw new Error(`telegram file too large (${buf.length} bytes; max ${maxBytes}). Send a smaller photo or increase cap.`);
  }
  return buf.toString("base64");
}

export function telegramBotTokenForFileFetch(): string | null {
  const t =
    (process.env.MYCLAW_TELEGRAM_BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  return t || null;
}

/**
 * If args include telegram.fileId, download in Next.js and set raw imageBase64 (bytes path only).
 * Removes planner imageUrl and strips fileId from `telegram` so weight-mcp needs no TELEGRAM_BOT_TOKEN for this call.
 */
export async function hydrateWeightAnalyzeMealPhotoFromTelegram(args: Record<string, unknown>): Promise<void> {
  const token = telegramBotTokenForFileFetch();
  if (!token) return;

  const tg = args.telegram;
  if (typeof tg !== "object" || tg === null) return;
  const rec = tg as Record<string, unknown>;
  const fileId = typeof rec.fileId === "string" ? rec.fileId.trim() : "";
  if (!fileId) return;

  const hasB64 = typeof args.imageBase64 === "string" && args.imageBase64.trim().length > 0;
  if (hasB64) return;

  const b64 = await fetchTelegramFileAsBase64(token, fileId);
  args.imageBase64 = b64;
  delete args.imageUrl;

  const chatId = typeof rec.chatId === "string" ? rec.chatId.trim() : "";
  const messageId =
    typeof rec.messageId === "number" && Number.isFinite(rec.messageId) ? Math.trunc(rec.messageId) : undefined;
  if (chatId || messageId != null) {
    args.telegram = {
      ...(chatId ? { chatId } : {}),
      ...(messageId != null ? { messageId } : {}),
    };
  } else {
    delete args.telegram;
  }
}
