import type { SuggestedAction } from "@/lib/agents/types";
import { extractTelegramMessagePhotoFileId } from "@/lib/telegram/photoFileId";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function safeJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return v;
  }
}

/**
 * SAFETY NET only. LangGraph `/goal tick` should **initiate** meal-photo processing via explicit
 * `mcp.tool` gym-weight actions (see graph.py). This module patches the action list when the
 * deployed planner still omits them, using `[context]` fileId lines or `telegram_list_messages` results.
 */

function actionsHaveWeightMcp(actions: SuggestedAction[]): boolean {
  for (const a of actions) {
    if (a.type !== "mcp.tool" || !a.input || typeof a.input !== "object") continue;
    const inp = a.input as Record<string, unknown>;
    if (inp.server === "gym-weight") return true;
  }
  return false;
}

function actionsHaveTelegramListMessages(actions: SuggestedAction[]): boolean {
  for (const a of actions) {
    if (a.type !== "mcp.tool" || !a.input || typeof a.input !== "object") continue;
    const inp = a.input as Record<string, unknown>;
    if (inp.server === "gym-telegram" && inp.tool === "telegram_list_messages") return true;
  }
  return false;
}

/** User (or context) indicates we should run meal-photo vision when file_ids appear. */
export function shouldRunMealPhotoSidecar(fullBlob: string): boolean {
  const contextHasPhotoIds = /msg#\d+\s+fileId=/.test(fullBlob);
  const intent = telegramMealPhotoUserIntent(fullBlob);
  return (
    intent ||
    (contextHasPhotoIds && /\b(photo|picture|image|meal|food|calor|process|telegram)\b/i.test(fullBlob))
  );
}

/** Match calorie/photo Telegram hints and plain "process the image" style prompts. */
export function telegramMealPhotoUserIntent(blob: string): boolean {
  const t = blob.toLowerCase();
  if (t.includes("telegram") && /\b(calorie|calories|nutrition|macro)\b/.test(t)) return true;
  if (/\b(calorie|calories|nutrition|macro)\b/.test(t) && /\b(photo|picture|image|pic|camera)\b/.test(t)) return true;
  if (/\bprocess\b/.test(t) && /\b(image|images|photo|photos|picture|pictures)\b/.test(t)) return true;
  if (/\b(analyze|analysis)\b/.test(t) && /\b(photo|picture|image|meal)\b/.test(t)) return true;
  return false;
}

function extractChatIdFromBlob(blob: string): string | null {
  const pats = [
    /use telegram_list_messages with chatId ([-\d]+)/,
    /with chatId ([-\d]+)/,
    /\bchatId=(-?\d+)/,
  ];
  for (const pat of pats) {
    const m = pat.exec(blob);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

function extractMsgFileIds(blob: string): Array<{ messageId: number; fileId: string }> {
  const out: Array<{ messageId: number; fileId: string }> = [];
  const re = /msg#(\d+)\s+fileId=([^:\s]+)\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(blob)) !== null) {
    const mid = parseInt(m[1]!, 10);
    const fid = (m[2] ?? "").trim();
    if (!Number.isFinite(mid) || !fid) continue;
    out.push({ messageId: mid, fileId: fid });
  }
  return out;
}

function goalTelegramChatTitle(): string {
  return (
    (process.env.MYCLAW_GOAL_TELEGRAM_CHAT_TITLE ?? process.env.MYCLAW_TELEGRAM_WATCH_CHAT_TITLE ?? "Smart Agent").trim() ||
    "Smart Agent"
  );
}

export function injectTelegramMealPhotoActionsIfNeeded(params: {
  /** `messageToSend` including optional `[context]` block. */
  fullBlob: string;
  session: { churchId: string; userId: string; personId: string; householdId?: string | null };
  actions: SuggestedAction[];
}): SuggestedAction[] {
  const { fullBlob, session, actions } = params;

  if (!shouldRunMealPhotoSidecar(fullBlob)) return actions;
  if (actionsHaveWeightMcp(actions)) return actions;
  if (!session.churchId || !session.userId || !session.personId) return actions;

  const scope: Record<string, unknown> = {
    churchId: session.churchId,
    userId: session.userId,
    personId: session.personId,
  };
  if (session.householdId) scope.householdId = session.householdId;

  const cid = extractChatIdFromBlob(fullBlob);
  const pairs = extractMsgFileIds(fullBlob);

  const prefix: SuggestedAction[] = [];

  if (pairs.length && cid) {
    for (const { messageId, fileId } of pairs.slice(0, 6)) {
      prefix.push({
        type: "mcp.tool",
        input: {
          server: "gym-weight",
          tool: "weight_analyze_meal_photo",
          args: {
            scope,
            telegram: { fileId, chatId: cid, messageId },
            meal: "Meal photo from Telegram (injected)",
          },
        },
      });
    }
    return [...prefix, ...actions];
  }

  if (cid && !actionsHaveTelegramListMessages(actions)) {
    prefix.push({
      type: "mcp.tool",
      input: {
        server: "gym-telegram",
        tool: "telegram_list_messages",
        args: { chatId: cid, limit: 40 },
      },
    });
    return [...prefix, ...actions];
  }

  if (!cid && !actionsHaveTelegramListMessages(actions)) {
    prefix.push({
      type: "mcp.tool",
      input: {
        server: "gym-telegram",
        tool: "telegram_list_messages",
        args: { chatTitle: goalTelegramChatTitle(), limit: 40 },
      },
    });
    return [...prefix, ...actions];
  }

  return actions;
}

/** Dedupe weight_analyze_meal_photo actions already in the plan (from pre-inject). */
export function seedMealPhotoDedupeFromActions(actions: SuggestedAction[]): Set<string> {
  const s = new Set<string>();
  for (const a of actions) {
    if (a.type !== "mcp.tool" || !isRecord(a.input)) continue;
    if (a.input.tool !== "weight_analyze_meal_photo") continue;
    const args = isRecord(a.input.args) ? a.input.args : null;
    const tg = args && isRecord(args.telegram) ? args.telegram : null;
    if (
      !tg ||
      typeof tg.chatId !== "string" ||
      typeof tg.messageId !== "number" ||
      typeof tg.fileId !== "string"
    ) {
      continue;
    }
    s.add(`${tg.chatId}:${tg.messageId}:${tg.fileId}`);
  }
  return s;
}

/**
 * After telegram_list_messages returns, enqueue gym-weight analyzes for each photo (same request).
 */
export function weightAnalyzeActionsFromTelegramListResult(
  mcpResult: unknown,
  session: { churchId: string; userId: string; personId: string; householdId?: string | null },
  fullBlob: string,
  dedupe: Set<string>,
): SuggestedAction[] {
  if (!shouldRunMealPhotoSidecar(fullBlob)) return [];
  if (!session.churchId || !session.userId || !session.personId) return [];

  const parsed = safeJson(mcpResult);
  if (!isRecord(parsed)) return [];
  const chatId = typeof parsed.chatId === "string" ? parsed.chatId : null;
  const messages = Array.isArray(parsed.messages) ? parsed.messages : null;
  if (!chatId || !messages?.length) return [];

  const scope: Record<string, unknown> = {
    churchId: session.churchId,
    userId: session.userId,
    personId: session.personId,
  };
  if (session.householdId) scope.householdId = session.householdId;

  const out: SuggestedAction[] = [];
  for (const m of messages) {
    if (!isRecord(m)) continue;
    const messageId = typeof m.messageId === "number" ? m.messageId : null;
    if (messageId == null) continue;
    const fileId = extractTelegramMessagePhotoFileId(m);
    if (!fileId) continue;
    const key = `${chatId}:${messageId}:${fileId}`;
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    out.push({
      type: "mcp.tool",
      input: {
        server: "gym-weight",
        tool: "weight_analyze_meal_photo",
        args: {
          scope,
          meal: "Telegram meal photo (from list_messages)",
          telegram: { fileId, chatId, messageId },
        },
      },
    });
    if (out.length >= 6) break;
  }
  return out;
}
