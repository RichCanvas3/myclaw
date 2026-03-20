/**
 * Telegram Bot API helpers for meal photos.
 * For `weight_analyze_meal_photo`, myclaw resolves a **download URL** via `getFile` (no image bytes)
 * and passes `imageUrl` to gym-weight; the worker fetches the URL and runs vision.
 */

import { logMyclaw } from "@/lib/observability";

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024; // 8 MiB — only used if something still downloads bytes locally

/** HTTPS URL to the file on Telegram’s CDN (includes bot token in path — treat as secret). */
export async function resolveTelegramFileHttpUrl(botToken: string, fileId: string): Promise<string> {
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
  return `https://api.telegram.org/file/bot${token}/${filePath}`;
}

/** Legacy: download file bytes (avoid for MCP → weight; prefer resolveTelegramFileHttpUrl + gym-weight fetch). */
export async function fetchTelegramFileAsBase64(
  botToken: string,
  fileId: string,
  maxBytes: number = DEFAULT_MAX_BYTES,
): Promise<string> {
  const fileUrl = await resolveTelegramFileHttpUrl(botToken, fileId);
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

function hasUsableImageUrl(args: Record<string, unknown>): boolean {
  const u = typeof args.imageUrl === "string" ? args.imageUrl.trim() : "";
  if (!u) return false;
  try {
    const x = new URL(u);
    return x.protocol === "https:" || x.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * If `telegram.fileId` is set and `MYCLAW_TELEGRAM_BOT_TOKEN` is available, resolve Telegram `getFile`
 * → **imageUrl** only (no bytes on this host). Strips `fileId` from `telegram` so the JSON to gym-weight
 * does not duplicate sources. If no token, leaves `fileId` for gym-weight (`TELEGRAM_BOT_TOKEN` there).
 *
 * Clears `imageBase64` when setting `imageUrl` so large payloads are not sent to the worker.
 */
export async function hydrateWeightAnalyzeMealPhotoFromTelegram(args: Record<string, unknown>): Promise<void> {
  const tg = args.telegram;
  if (typeof tg !== "object" || tg === null) return;
  const rec = tg as Record<string, unknown>;
  const fileId = typeof rec.fileId === "string" ? rec.fileId.trim() : "";
  if (!fileId) return;

  if (hasUsableImageUrl(args)) return;

  const token = telegramBotTokenForFileFetch();
  if (!token) {
    return;
  }

  const url = await resolveTelegramFileHttpUrl(token, fileId);
  delete args.imageBase64;
  args.imageUrl = url;

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

  logMyclaw("telegram-hydrate", "fileId → imageUrl for weight_analyze_meal_photo (bytes fetched in gym-weight)", {
    fileIdPrefix: `${fileId.slice(0, 12)}…`,
    chatId: chatId || undefined,
    messageId,
  });
}
