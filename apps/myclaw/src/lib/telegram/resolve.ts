import { mcpToolsCall } from "@/lib/mcp/client";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function normStr(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function parseTelegramChats(v: unknown): Array<{ chatId: string; title?: string | null; username?: string | null }> {
  const parsed = typeof v === "string" ? tryParseJson(v) : v;
  if (!isRecord(parsed)) return [];
  const chats = parsed.chats;
  if (!Array.isArray(chats)) return [];
  const out: Array<{ chatId: string; title?: string | null; username?: string | null }> = [];
  for (const c of chats) {
    if (!isRecord(c)) continue;
    const chatId = normStr(c.chatId);
    if (!chatId) continue;
    out.push({ chatId, title: normStr(c.title), username: normStr(c.username) });
  }
  return out;
}

export async function resolveTelegramChatIdByTitle(title: string): Promise<string | null> {
  const resp = await mcpToolsCall("gym-telegram", "telegram_list_chats", {});
  const chats = parseTelegramChats(resp);
  const want = title.trim().toLowerCase();
  if (!want) return null;

  // Prefer exact title match; then exact @username match; then contains.
  const exactTitle = chats.find((c) => (c.title ?? "").trim().toLowerCase() === want);
  if (exactTitle) return exactTitle.chatId;
  const exactUser = chats.find((c) => (c.username ?? "").trim().toLowerCase() === want.replace(/^@/, ""));
  if (exactUser) return exactUser.chatId;
  const contains = chats.find((c) => (c.title ?? "").trim().toLowerCase().includes(want));
  return contains ? contains.chatId : null;
}

