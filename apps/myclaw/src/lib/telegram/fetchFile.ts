/**
 * Telegram Bot API helpers for meal photos.
 * For `weight_analyze_meal_photo`, myclaw resolves a **download URL** via `getFile` (no image bytes)
 * and passes `imageUrl` to gym-weight; the worker fetches the URL and runs vision.
 */

import { logMyclaw } from "@/lib/observability";
import { telegramFileIdLooksPlaceholder } from "@/lib/telegram/photoFileId";

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
    logMyclaw("telegram-hydrate", "skip imageUrl: no bot token on myclaw; forwarding fileId to gym-weight (needs TELEGRAM_BOT_TOKEN there)", {
      fileIdPrefix: `${fileId.slice(0, 12)}…`,
      suspect_placeholder: telegramFileIdLooksPlaceholder(fileId),
    });
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

/**
 * After hydrate: ensure we did not send an unusable plan (missing image source or fake fileId).
 */
export function validateWeightAnalyzeMealPhotoArgs(args: Record<string, unknown>): void {
  if (hasUsableImageUrl(args)) return;
  const rawB64 = typeof args.imageBase64 === "string" ? args.imageBase64.trim() : "";
  if (rawB64.length > 0) return;

  const tg = args.telegram;
  const rec = typeof tg === "object" && tg !== null ? (tg as Record<string, unknown>) : null;
  const fileId = rec && typeof rec.fileId === "string" ? rec.fileId.trim() : "";

  if (!fileId) {
    throw new Error(
      "weight_analyze_meal_photo: no image source — add MYCLAW_TELEGRAM_BOT_TOKEN on myclaw (preferred), or a real telegram.fileId from telegram_list_messages plus TELEGRAM_BOT_TOKEN on gym-weight, or imageBase64.",
    );
  }
  if (telegramFileIdLooksPlaceholder(fileId)) {
    throw new Error(
      "weight_analyze_meal_photo: telegram.fileId is not a real Telegram file_id (looks like a placeholder). Call telegram_list_messages and copy the exact fileId from the photo line in the JSON.",
    );
  }
}
