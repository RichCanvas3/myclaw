import type { OrchestratorContext, SuggestedAction } from "@/lib/agents/types";
import { mcpToolsCall } from "@/lib/mcp/client";
import { memoryAppendEvent, memoryGet, memoryGetProfile, memoryUpsert } from "@/lib/memory/client";
import { orchestratorPlan } from "@/lib/orchestrator/llm";
import { resolveTelegramChatIdByTitle } from "@/lib/telegram/resolve";

export const runtime = "nodejs";

type PumpRequest = {
  churchId?: string;
  userId?: string;
  personId?: string;
  householdId?: string | null;
  subscribeTitles?: string[];
  // Testing/ops: override cursor comparison for this request.
  sinceMessageId?: number;
  includeBacklog?: boolean;
};

type ChatInfo = { chatId: string; title?: string | null };
type TelegramMsg = { messageId: number; fromUserId?: number | null; text?: string | null; dateUnix?: number | null };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function normStr(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}

function envBool(name: string, defaultValue: boolean): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return defaultValue;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function envInt(name: string, defaultValue: number): number {
  const raw = (process.env[name] ?? "").trim();
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : defaultValue;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function defaultCtx(body: PumpRequest): OrchestratorContext {
  const churchId = (body.churchId ?? process.env.MYCLAW_TELEGRAM_DEFAULT_CHURCH_ID ?? "t_cust_casey").toString();
  const userId = (body.userId ?? process.env.MYCLAW_TELEGRAM_DEFAULT_USER_ID ?? "acct_cust_casey").toString();
  const personId = (body.personId ?? process.env.MYCLAW_TELEGRAM_DEFAULT_PERSON_ID ?? "p_casey").toString();
  const householdId = (body.householdId ?? process.env.MYCLAW_TELEGRAM_DEFAULT_HOUSEHOLD_ID ?? "hh_casey") || null;
  return { churchId, userId, personId, householdId };
}

function parseChats(resp: unknown): ChatInfo[] {
  const parsed = typeof resp === "string" ? safeJson(resp) : resp;
  if (!isRecord(parsed) || !Array.isArray(parsed.chats)) return [];
  const out: ChatInfo[] = [];
  for (const c of parsed.chats) {
    if (!isRecord(c)) continue;
    const chatIdRaw = c.chatId;
    const chatId =
      typeof chatIdRaw === "string"
        ? chatIdRaw.trim()
        : typeof chatIdRaw === "number" && Number.isFinite(chatIdRaw)
          ? String(chatIdRaw)
          : null;
    if (!chatId) continue;
    out.push({ chatId, title: normStr(c.title) });
  }
  return out;
}

function parseListMessages(resp: unknown): { chatId: string; messages: TelegramMsg[] } | null {
  const parsed = typeof resp === "string" ? safeJson(resp) : resp;
  if (!isRecord(parsed)) return null;
  const chatId = normStr(parsed.chatId);
  if (!chatId || !Array.isArray(parsed.messages)) return null;
  const out: TelegramMsg[] = [];
  for (const m of parsed.messages) {
    if (!isRecord(m)) continue;
    const messageId = typeof m.messageId === "number" ? m.messageId : null;
    if (!messageId) continue;
    out.push({
      messageId,
      fromUserId: typeof m.fromUserId === "number" ? m.fromUserId : null,
      dateUnix: typeof m.dateUnix === "number" ? m.dateUnix : null,
      text: normStr(m.text),
    });
  }
  return { chatId, messages: out };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function cursorMap(): Map<string, number> {
  const g = globalThis as unknown as { __myclawTelegramLastSeen?: Map<string, number> };
  if (!g.__myclawTelegramLastSeen) g.__myclawTelegramLastSeen = new Map<string, number>();
  return g.__myclawTelegramLastSeen;
}

async function getLastSeen(ctx: OrchestratorContext, chatId: string): Promise<number | null> {
  const key = `telegram:lastSeen:${chatId}`;
  const resp = await memoryGet({ ctx, namespace: "threads", key }).catch(() => null);
  if (!isRecord(resp) || !isRecord(resp.value)) return null;
  const v = resp.value as Record<string, unknown>;
  const persisted = typeof v.lastMessageId === "number" ? v.lastMessageId : null;
  if (persisted != null) return persisted;
  return cursorMap().get(chatId) ?? null;
}

async function setLastSeen(ctx: OrchestratorContext, chatId: string, lastMessageId: number): Promise<void> {
  cursorMap().set(chatId, lastMessageId);
  const key = `telegram:lastSeen:${chatId}`;
  await memoryUpsert({
    ctx,
    namespace: "threads",
    key,
    value: { chatId, lastMessageId, lastSeenAtISO: new Date().toISOString() },
  }).catch(() => {});
}

function allowAutoAction(a: SuggestedAction): boolean {
  if (a.type !== "mcp.tool") return false;
  const input = a.input as unknown;
  if (!isRecord(input)) return false;
  return input.server === "gym-telegram" && input.tool === "telegram_send_message";
}

async function executeAutoActions(chatId: string, actions: SuggestedAction[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const a of actions) {
    if (!allowAutoAction(a)) continue;
    const input = a.input as unknown;
    let args: Record<string, unknown> = {};
    if (isRecord(input) && isRecord(input.args)) args = { ...(input.args as Record<string, unknown>) };
    if (!("chatId" in args)) args.chatId = chatId;
    out.push(await mcpToolsCall("gym-telegram", "telegram_send_message", args));
  }
  return out;
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as PumpRequest;
  const ctxBase = defaultCtx(body);

  const enabled = envBool("MYCLAW_TELEGRAM_AUTOPOLL", true);
  if (!enabled) return json({ ok: true, enabled: false });

  const autoReply = envBool("MYCLAW_TELEGRAM_AUTOREPLY", false);
  const limit = Math.max(1, Math.min(50, envInt("MYCLAW_TELEGRAM_POLL_LIMIT", 20)));
  const maxChats = Math.max(1, Math.min(100, envInt("MYCLAW_TELEGRAM_POLL_MAX_CHATS", 25)));
  const botUserId = envInt("MYCLAW_TELEGRAM_BOT_USER_ID", 0) || null;

  let chats: ChatInfo[] = [];
  const titles = Array.isArray(body.subscribeTitles) ? body.subscribeTitles.filter((t) => typeof t === "string") : [];
  if (titles.length) {
    for (const title of titles) {
      const resolved = await resolveTelegramChatIdByTitle(title).catch(() => null);
      if (resolved) chats.push({ chatId: resolved, title });
    }
  } else {
    const resp = await mcpToolsCall("gym-telegram", "telegram_list_chats", {});
    chats = parseChats(resp).slice(0, maxChats);
  }

  const processed: Array<{ chatId: string; title?: string | null; newMessages: TelegramMsg[]; replies: unknown[] }> = [];

  for (const chat of chats) {
    const ctx: OrchestratorContext = { ...ctxBase, threadId: `telegram:${chat.chatId}` };

    const persistedLastSeen = await getLastSeen(ctx, chat.chatId);
    const overrideSince =
      typeof body.sinceMessageId === "number" && Number.isFinite(body.sinceMessageId) ? body.sinceMessageId : null;
    const lastSeen = overrideSince != null ? overrideSince : persistedLastSeen;
    const listResp = await mcpToolsCall("gym-telegram", "telegram_list_messages", { chatId: chat.chatId, limit }).catch(() => null);
    const list = listResp ? parseListMessages(listResp) : null;
    if (!list) continue;

    const newest = list.messages.reduce((mx, m) => Math.max(mx, m.messageId), lastSeen ?? 0);
    if (lastSeen == null) {
      // First time: set cursor, don't auto-reply to backlog.
      if (newest) await setLastSeen(ctx, chat.chatId, newest);
      if (!body.includeBacklog) continue;
    }

    const lastSeenForCompare = lastSeen ?? 0;
    const newMessages = list.messages
      .filter((m) => m.messageId > lastSeenForCompare)
      .filter((m) => (botUserId ? m.fromUserId !== botUserId : true))
      .filter((m) => (m.text ?? "").trim().length > 0);

    if (!newMessages.length) {
      if (newest && newest > lastSeenForCompare) await setLastSeen(ctx, chat.chatId, newest);
      continue;
    }

    if (newest && newest > lastSeenForCompare) await setLastSeen(ctx, chat.chatId, newest);

    const replies: unknown[] = [];
    if (autoReply) {
      const memoryProfile = await memoryGetProfile(ctx).catch(() => null);
      const lastMsg = newMessages.sort((a, b) => a.messageId - b.messageId)[newMessages.length - 1];
      const prompt =
        `Incoming Telegram message.\n` +
        `chatTitle="${chat.title ?? ""}" chatId="${chat.chatId}" messageId="${lastMsg.messageId}".\n` +
        `Message:\n${lastMsg.text ?? ""}\n\n` +
        `Decide if/how to respond. Only respond if the user is addressing you. If responding, use ONLY telegram_send_message to this same chatId.`;

      const planned = await orchestratorPlan({
        userMessage: prompt,
        session: {
          churchId: ctx.churchId,
          userId: ctx.userId,
          personId: ctx.personId,
          householdId: ctx.householdId ?? null,
        },
        threadId: ctx.threadId ?? `telegram:${chat.chatId}`,
        memoryProfile,
        nowISO: new Date().toISOString(),
      }).catch(() => null);

      if (planned?.actions?.length) {
        const executed = await executeAutoActions(chat.chatId, planned.actions).catch(() => []);
        replies.push(...executed);
        await memoryAppendEvent({
          ctx,
          type: "telegram.autoreply",
          payload: { chat, newMessages, plannedActions: planned.actions, executed },
        }).catch(() => {});
      }
    }

    await memoryAppendEvent({ ctx, type: "telegram.detected", payload: { chat, newMessages } }).catch(() => {});
    processed.push({ chatId: chat.chatId, title: chat.title, newMessages, replies });
  }

  return json({ ok: true, processed });
}

