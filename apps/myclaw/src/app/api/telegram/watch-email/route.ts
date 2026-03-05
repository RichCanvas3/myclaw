import type { OrchestratorContext } from "@/lib/agents/types";
import { mcpResourcesList, mcpResourcesRead, mcpResourcesSubscribe, mcpToolsCall } from "@/lib/mcp/client";
import { memoryAppendEvent, memoryGet, memoryUpsert } from "@/lib/memory/client";

export const runtime = "nodejs";

type WatchEmailRequest = {
  churchId?: string;
  userId?: string;
  personId?: string;
  householdId?: string | null;
  chatTitle?: string; // default: Smart Agent
  to?: string; // default: env or richardpedersen3@gmail.com
  // Optional: caller can pin the MCP session id (useful for stateless cron runners).
  sessionId?: string;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function normStr(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function defaultCtx(body: WatchEmailRequest): OrchestratorContext {
  const churchId = (body.churchId ?? process.env.MYCLAW_TELEGRAM_DEFAULT_CHURCH_ID ?? "t_cust_casey").toString();
  const userId = (body.userId ?? process.env.MYCLAW_TELEGRAM_DEFAULT_USER_ID ?? "acct_cust_casey").toString();
  const personId = (body.personId ?? process.env.MYCLAW_TELEGRAM_DEFAULT_PERSON_ID ?? "p_casey").toString();
  const householdId = (body.householdId ?? process.env.MYCLAW_TELEGRAM_DEFAULT_HOUSEHOLD_ID ?? "hh_casey") || null;
  return { churchId, userId, personId, householdId, threadId: "telegram:watch-email" };
}

function requireTokenIfConfigured(req: Request): Response | null {
  const expected = (process.env.MYCLAW_TELEGRAM_WATCH_TOKEN ?? "").trim();
  if (!expected) return null;
  const auth = (req.headers.get("authorization") ?? "").trim();
  const got = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  if (!got || got !== expected) return new Response("Unauthorized", { status: 401 });
  return null;
}

function extractSessionId(resp: unknown): string | null {
  if (!isRecord(resp)) return null;
  const sid = resp.sessionId;
  return typeof sid === "string" && sid.trim() ? sid.trim() : null;
}

function extractReadMessages(result: unknown): { chatId: string; messages: Array<{ messageId: number; fromUserId?: number | null; text?: string | null; dateUnix?: number | null }> } | null {
  // resources/read result typically: { contents: [{ uri, mimeType, text: "{...json...}" }, ...] }
  if (!isRecord(result)) return null;
  const contents = result.contents;
  if (!Array.isArray(contents) || !contents.length) return null;
  const first = contents[0];
  if (!isRecord(first) || typeof first.text !== "string") return null;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(first.text) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const chatId = normStr(parsed.chatId);
  const msgs = parsed.messages;
  if (!chatId || !Array.isArray(msgs)) return null;
  const out: Array<{ messageId: number; fromUserId?: number | null; text?: string | null; dateUnix?: number | null }> = [];
  for (const m of msgs) {
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

function hasUpdatedNotification(events: unknown[], uri: string): boolean {
  for (const ev of events) {
    if (!isRecord(ev)) continue;
    if (ev.method !== "notifications/resources/updated") continue;
    const params = ev.params;
    if (!isRecord(params)) continue;
    if (params.uri === uri) return true;
  }
  return false;
}

function fallbackStore(): {
  sessionByScope: Map<string, string>;
  lastEmailedByChat: Map<string, number>;
} {
  const g = globalThis as unknown as {
    __myclawTelegramSessionByScope?: Map<string, string>;
    __myclawTelegramLastEmailedByChat?: Map<string, number>;
  };
  if (!g.__myclawTelegramSessionByScope) g.__myclawTelegramSessionByScope = new Map<string, string>();
  if (!g.__myclawTelegramLastEmailedByChat) g.__myclawTelegramLastEmailedByChat = new Map<string, number>();
  return { sessionByScope: g.__myclawTelegramSessionByScope, lastEmailedByChat: g.__myclawTelegramLastEmailedByChat };
}

function scopeKey(ctx: OrchestratorContext): string {
  return `${ctx.churchId}:${ctx.userId}:${ctx.personId}:${ctx.householdId ?? ""}`;
}

async function getStoredSessionId(ctx: OrchestratorContext): Promise<string | null> {
  const key = "telegram:mcp_session_id";
  const resp = await memoryGet({ ctx, namespace: "threads", key }).catch(() => null);
  if (!isRecord(resp) || !isRecord(resp.value)) return null;
  const v = resp.value as Record<string, unknown>;
  return typeof v.sessionId === "string" && v.sessionId.trim() ? v.sessionId.trim() : null;
}

async function storeSessionId(ctx: OrchestratorContext, sessionId: string): Promise<void> {
  const key = "telegram:mcp_session_id";
  await memoryUpsert({ ctx, namespace: "threads", key, value: { sessionId, updatedAtISO: new Date().toISOString() } }).catch(
    () => {},
  );
}

async function getLastEmailed(ctx: OrchestratorContext, chatId: string): Promise<number | null> {
  const key = `telegram:lastEmailed:${chatId}`;
  const resp = await memoryGet({ ctx, namespace: "threads", key }).catch(() => null);
  if (!isRecord(resp) || !isRecord(resp.value)) return null;
  const v = resp.value as Record<string, unknown>;
  return typeof v.messageId === "number" ? v.messageId : null;
}

async function setLastEmailed(ctx: OrchestratorContext, chatId: string, messageId: number): Promise<void> {
  const key = `telegram:lastEmailed:${chatId}`;
  await memoryUpsert({ ctx, namespace: "threads", key, value: { messageId, atISO: new Date().toISOString() } }).catch(() => {});
}

export async function POST(req: Request): Promise<Response> {
  const unauthorized = requireTokenIfConfigured(req);
  if (unauthorized) return unauthorized;

  const body = (await req.json().catch(() => ({}))) as WatchEmailRequest;
  const ctx = defaultCtx(body);

  const chatTitle = (body.chatTitle ?? process.env.MYCLAW_TELEGRAM_WATCH_CHAT_TITLE ?? "Smart Agent").toString();
  const uri = `telegram://chat/by-title/${encodeURIComponent(chatTitle)}/messages`;
  const to = (body.to ?? process.env.MYCLAW_TELEGRAM_NOTIFY_EMAIL_TO ?? "richardpedersen3@gmail.com").toString();
  const botUserIdRaw = (process.env.MYCLAW_TELEGRAM_BOT_USER_ID ?? "").trim();
  const botUserId = botUserIdRaw ? Number(botUserIdRaw) : null;
  const mode = ((process.env.MYCLAW_TELEGRAM_NOTIFY_MODE ?? "both").trim().toLowerCase() as
    | "notification"
    | "cursor"
    | "both");

  // 1) Acquire / reuse MCP session id.
  const fallback = fallbackStore();
  const sk = scopeKey(ctx);
  let sessionId = normStr(body.sessionId) ?? (await getStoredSessionId(ctx)) ?? fallback.sessionByScope.get(sk) ?? null;
  if (sessionId) {
    fallback.sessionByScope.set(sk, sessionId);
    await storeSessionId(ctx, sessionId);
  }
  if (!sessionId) {
    const resList = await mcpResourcesList("gym-telegram");
    sessionId = resList.sessionId ?? null;
    if (sessionId) {
      fallback.sessionByScope.set(sk, sessionId);
      await storeSessionId(ctx, sessionId);
    }
  }
  if (!sessionId) return json({ ok: false, error: "missing_mcp_session_id" }, 500);

  // 2) Ensure subscription exists for this session (idempotent).
  await mcpResourcesSubscribe("gym-telegram", uri, { sessionId });

  // 3) Poll: read (this is also where pending notifications get delivered).
  const read = await mcpResourcesRead("gym-telegram", uri, { sessionId });
  const notified = hasUpdatedNotification(read.events, uri);

  const msgList = extractReadMessages(read.result);
  const latest = msgList?.messages?.[0] ?? null;

  // 4) Email policy:
  // - notification: only send on notified=true
  // - cursor: send when latest.messageId advances (deduped), regardless of notified
  // - both: send when either condition is true (still deduped)
  let emailed = false;
  let reason: string | null = null;
  let trigger: "notification" | "cursor" | null = null;

  if (!msgList || !latest) {
    reason = "no_messages_in_read";
  } else if (botUserId != null && latest.fromUserId === botUserId) {
    reason = "ignored_bot_message";
  } else {
    const lastEmailed = (await getLastEmailed(ctx, msgList.chatId)) ?? fallback.lastEmailedByChat.get(msgList.chatId) ?? null;
    if (lastEmailed != null && latest.messageId <= lastEmailed) {
      reason = "already_emailed";
    } else {
      const shouldByNotification = notified;
      const shouldByCursor = true; // messageId advanced relative to lastEmailed (checked above)
      const shouldSend =
        mode === "notification" ? shouldByNotification : mode === "cursor" ? shouldByCursor : shouldByNotification || shouldByCursor;

      if (!shouldSend) {
        reason = mode === "notification" ? "no_notification_event" : "suppressed";
      } else {
        trigger = notified ? "notification" : "cursor";
      const subject = `New Telegram message in ${chatTitle}`;
      const text =
        `Chat: ${chatTitle}\n` +
        `ChatId: ${msgList.chatId}\n` +
        `MessageId: ${latest.messageId}\n` +
        `FromUserId: ${latest.fromUserId ?? ""}\n` +
        `DateUnix: ${latest.dateUnix ?? ""}\n\n` +
        `${latest.text ?? ""}`;

        try {
          await mcpToolsCall("gym-sendgrid", "sendEmail", { to, subject, text });
          fallback.lastEmailedByChat.set(msgList.chatId, latest.messageId);
          await setLastEmailed(ctx, msgList.chatId, latest.messageId);
          emailed = true;
          reason = null;
          await memoryAppendEvent({
            ctx,
            type: "telegram.email_sent",
            payload: { chatTitle, uri, to, chatId: msgList.chatId, messageId: latest.messageId, trigger },
          }).catch(() => {});
        } catch (e) {
          emailed = false;
          trigger = null;
          reason = `sendgrid_error:${(e as Error).message}`;
        }
      }
    }
  }

  return json({
    ok: true,
    sessionId,
    uri,
    notified,
    latest: latest ? { messageId: latest.messageId, fromUserId: latest.fromUserId, text: latest.text } : null,
    emailed,
    reason,
    trigger,
    mode,
  });
}

