import type { OrchestratorContext } from "@/lib/agents/types";
import { mcpResourcesList, mcpResourcesRead, mcpResourcesSubscribe, mcpToolsCall } from "@/lib/mcp/client";
import { memoryAppendEvent, memoryGet, memoryUpsert } from "@/lib/memory/client";
import { hydrateWeightAnalyzeMealPhotoFromTelegram, telegramBotTokenForFileFetch } from "@/lib/telegram/fetchFile";
import { extractTelegramMessagePhotoFileId } from "@/lib/telegram/photoFileId";

export const runtime = "nodejs";

type WatchGoalRequest = {
  churchId?: string;
  userId?: string;
  personId?: string;
  householdId?: string | null;
  chatTitle?: string; // default: Smart Agent
  // Optional: caller can pin the MCP session id (useful for stateless cron runners).
  sessionId?: string;
  // Ops: first run sets cursor and does nothing unless true.
  includeBacklog?: boolean;
  // Safety: cap number of messages processed per call.
  maxMessages?: number;
};

type TelegramMsg = {
  messageId: number;
  fromUserId?: number | null;
  text?: string | null;
  caption?: string | null;
  dateUnix?: number | null;
  /** Largest photo file_id when MCP exposes photos[] / photo / document. */
  photoFileId?: string | null;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function normStr(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}

function mealPhotoProcessedKey(chatId: string, messageId: number): string {
  return `telegram:mealPhotoProcessed:${chatId}:${messageId}`;
}

function safeJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return v;
  }
}

async function wasMealPhotoAlreadyProcessed(ctx: OrchestratorContext, chatId: string, messageId: number): Promise<boolean> {
  const key = mealPhotoProcessedKey(chatId, messageId);
  const resp = await memoryGet({ ctx, namespace: "threads", key }).catch(() => null);
  if (!isRecord(resp) || !isRecord(resp.value)) return false;
  const v = resp.value as Record<string, unknown>;
  return v.processed === true || typeof v.atISO === "string";
}

async function markMealPhotoProcessed(ctx: OrchestratorContext, chatId: string, messageId: number): Promise<void> {
  const key = mealPhotoProcessedKey(chatId, messageId);
  await memoryUpsert({
    ctx,
    namespace: "threads",
    key,
    value: { processed: true, atISO: new Date().toISOString() },
  }).catch(() => {});
}

/**
 * Vision + D1: wm_meal_analyses + wm_food_entries (aggregate) for each new Telegram photo in the watch feed.
 */
async function analyzeAndLogTelegramMealPhoto(params: {
  ctx: OrchestratorContext;
  chatId: string;
  msg: TelegramMsg;
}): Promise<{ ok: boolean; skipped?: boolean; error?: string; analysisId?: string }> {
  const fid = (params.msg.photoFileId ?? "").trim();
  if (!fid) return { ok: false, skipped: true, error: "no_photo_file_id" };

  if (await wasMealPhotoAlreadyProcessed(params.ctx, params.chatId, params.msg.messageId)) {
    return { ok: true, skipped: true };
  }

  if (!telegramBotTokenForFileFetch()) {
    return {
      ok: false,
      error: "MYCLAW_TELEGRAM_BOT_TOKEN required to fetch photo bytes for gym-weight",
    };
  }

  const scope: Record<string, unknown> = {
    churchId: params.ctx.churchId,
    userId: params.ctx.userId,
    personId: params.ctx.personId,
  };
  if (params.ctx.householdId) scope.householdId = params.ctx.householdId;

  const mealLabel =
    normStr(params.msg.caption) ?? normStr(params.msg.text) ?? "Telegram meal photo";

  const args: Record<string, unknown> = {
    scope,
    meal: mealLabel,
    telegram: {
      fileId: fid,
      chatId: params.chatId,
      messageId: params.msg.messageId,
    },
  };

  try {
    await hydrateWeightAnalyzeMealPhotoFromTelegram(args);
    const analyzedRaw = await mcpToolsCall("gym-weight", "weight_analyze_meal_photo", args);
    const parsed = safeJson(analyzedRaw);
    const analysisId = isRecord(parsed) && typeof parsed.analysisId === "string" ? parsed.analysisId.trim() : "";
    if (!analysisId) {
      const msg =
        typeof analyzedRaw === "string"
          ? analyzedRaw.slice(0, 800)
          : JSON.stringify(analyzedRaw).slice(0, 800);
      return { ok: false, error: `weight_analyze_meal_photo: no analysisId (${msg})` };
    }

    await mcpToolsCall("gym-weight", "weight_log_food_from_analysis", {
      scope,
      analysisId,
      mode: "aggregate",
      meal: mealLabel,
      source: "telegram_watch_goal",
      telegram: { chatId: params.chatId, messageId: params.msg.messageId },
    });

    await markMealPhotoProcessed(params.ctx, params.chatId, params.msg.messageId);
    return { ok: true, analysisId };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function defaultCtx(body: WatchGoalRequest): OrchestratorContext {
  const churchId = (body.churchId ?? process.env.MYCLAW_TELEGRAM_DEFAULT_CHURCH_ID ?? "t_cust_casey").toString();
  const userId = (body.userId ?? process.env.MYCLAW_TELEGRAM_DEFAULT_USER_ID ?? "acct_cust_casey").toString();
  const personId = (body.personId ?? process.env.MYCLAW_TELEGRAM_DEFAULT_PERSON_ID ?? "p_casey").toString();
  const householdId = (body.householdId ?? process.env.MYCLAW_TELEGRAM_DEFAULT_HOUSEHOLD_ID ?? "hh_casey") || null;
  return { churchId, userId, personId, householdId, threadId: "telegram:watch-goal" };
}

function requireTokenIfConfigured(req: Request): Response | null {
  const expected = (process.env.MYCLAW_TELEGRAM_WATCH_TOKEN ?? "").trim();
  if (!expected) return null;
  const auth = (req.headers.get("authorization") ?? "").trim();
  const got = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  if (!got || got !== expected) return new Response("Unauthorized", { status: 401 });
  return null;
}

function fallbackStore(): { sessionByScope: Map<string, string> } {
  const g = globalThis as unknown as { __myclawTelegramGoalSessionByScope?: Map<string, string> };
  if (!g.__myclawTelegramGoalSessionByScope) g.__myclawTelegramGoalSessionByScope = new Map<string, string>();
  return { sessionByScope: g.__myclawTelegramGoalSessionByScope };
}

function scopeKey(ctx: OrchestratorContext): string {
  return `${ctx.churchId}:${ctx.userId}:${ctx.personId}:${ctx.householdId ?? ""}`;
}

function goalThreadFallbackStore(): { threadByScopeAndChat: Map<string, string> } {
  const g = globalThis as unknown as { __myclawTelegramGoalThreadByScopeAndChat?: Map<string, string> };
  if (!g.__myclawTelegramGoalThreadByScopeAndChat) g.__myclawTelegramGoalThreadByScopeAndChat = new Map<string, string>();
  return { threadByScopeAndChat: g.__myclawTelegramGoalThreadByScopeAndChat };
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

async function getStoredGoalThreadId(ctx: OrchestratorContext, chatId: string): Promise<string | null> {
  const key = `telegram:goal_langgraph_thread_id:${chatId}`;
  const resp = await memoryGet({ ctx, namespace: "threads", key }).catch(() => null);
  if (!isRecord(resp) || !isRecord(resp.value)) return null;
  const v = resp.value as Record<string, unknown>;
  return typeof v.threadId === "string" && v.threadId.trim() ? v.threadId.trim() : null;
}

async function storeGoalThreadId(ctx: OrchestratorContext, chatId: string, threadId: string): Promise<void> {
  const key = `telegram:goal_langgraph_thread_id:${chatId}`;
  await memoryUpsert({
    ctx,
    namespace: "threads",
    key,
    value: { threadId, updatedAtISO: new Date().toISOString() },
  }).catch(() => {});
}

function extractReadMessages(result: unknown): { chatId: string; messages: TelegramMsg[] } | null {
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

  const out: TelegramMsg[] = [];
  for (const m of msgs) {
    if (!isRecord(m)) continue;
    const messageId = typeof m.messageId === "number" ? m.messageId : null;
    if (!messageId) continue;
    const photoFileId = extractTelegramMessagePhotoFileId(m);
    out.push({
      messageId,
      fromUserId: typeof m.fromUserId === "number" ? m.fromUserId : null,
      dateUnix: typeof m.dateUnix === "number" ? m.dateUnix : null,
      text: normStr(m.text),
      caption: normStr(m.caption),
      photoFileId: photoFileId ?? null,
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

async function getLastProcessed(ctx: OrchestratorContext, chatId: string): Promise<number | null> {
  const key = `telegram:lastGoalProcessed:${chatId}`;
  const resp = await memoryGet({ ctx, namespace: "threads", key }).catch(() => null);
  if (!isRecord(resp) || !isRecord(resp.value)) return null;
  const v = resp.value as Record<string, unknown>;
  return typeof v.messageId === "number" ? v.messageId : null;
}

async function setLastProcessed(ctx: OrchestratorContext, chatId: string, messageId: number): Promise<void> {
  const key = `telegram:lastGoalProcessed:${chatId}`;
  await memoryUpsert({
    ctx,
    namespace: "threads",
    key,
    value: { messageId, atISO: new Date().toISOString() },
  }).catch(() => {});
}

async function drainResponseBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) return;
  const reader = body.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

async function drainAndCaptureThreadId(body: ReadableStream<Uint8Array> | null): Promise<string | null> {
  if (!body) return null;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let captured: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Parse SSE blocks separated by blank line.
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const lines = part.split(/\r?\n/);
      const eventLine = lines.find((l) => l.startsWith("event: "));
      const dataLine = lines.find((l) => l.startsWith("data: "));
      if (!eventLine || !dataLine) continue;
      const event = eventLine.slice("event: ".length).trim();
      if (event !== "thread") continue;
      const dataRaw = dataLine.slice("data: ".length).trim();
      try {
        const data = JSON.parse(dataRaw) as unknown;
        if (isRecord(data) && typeof data.thread_id === "string" && data.thread_id.trim()) {
          captured = data.thread_id.trim();
        }
      } catch {
        // ignore
      }
    }
  }
  return captured;
}

async function runGoalTickFromTelegram(params: {
  reqUrl: string;
  ctx: OrchestratorContext;
  chatTitle: string;
  chatId: string;
  msg: TelegramMsg;
  langgraphThreadId: string | null;
}): Promise<{ ok: boolean; status: number; error?: string; threadId?: string | null }> {
  const url = new URL(params.reqUrl);
  const actUrl = new URL("/api/agent/act", url);

  const userText = (params.msg.text ?? params.msg.caption ?? "").trim();
  const hint =
    `Telegram update from "${params.chatTitle}" supergroup.\n` +
    `chatId=${params.chatId} messageId=${params.msg.messageId} fromUserId=${params.msg.fromUserId ?? ""}.\n\n` +
    `User message:\n${userText}\n\n` +
    `Important: reply in the same Telegram chat using telegram_send_message with chatId=${params.chatId}.`;

  const payload = {
    thread_id: params.langgraphThreadId,
    user_id: params.ctx.userId,
    church_id: params.ctx.churchId,
    org_id: params.ctx.churchId,
    person_id: params.ctx.personId,
    household_id: params.ctx.householdId ?? undefined,
    message: `/goal tick ${hint}`,
  };

  const resp = await fetch(actUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream, application/json" },
    body: JSON.stringify(payload),
  }).catch((e) => ({ ok: false, status: 599, body: null as any, text: async () => String((e as Error).message) } as any));

  if (!resp.ok) {
    const err = await resp.text().catch(() => "act_failed");
    return { ok: false, status: resp.status ?? 500, error: err.slice(0, 4000) };
  }

  // IMPORTANT: consume the SSE so the act route executes all actions.
  const tid = await drainAndCaptureThreadId(resp.body ?? null);
  return { ok: true, status: resp.status ?? 200, threadId: tid ?? params.langgraphThreadId };
}

export async function POST(req: Request): Promise<Response> {
  const unauthorized = requireTokenIfConfigured(req);
  if (unauthorized) return unauthorized;

  const body = (await req.json().catch(() => ({}))) as WatchGoalRequest;
  const ctx = defaultCtx(body);

  const chatTitle = (body.chatTitle ?? process.env.MYCLAW_TELEGRAM_WATCH_CHAT_TITLE ?? "Smart Agent").toString();
  const uri = `telegram://chat/by-title/${encodeURIComponent(chatTitle)}/messages`;
  const botUserIdRaw = (process.env.MYCLAW_TELEGRAM_BOT_USER_ID ?? "").trim();
  const botUserId = botUserIdRaw ? Number(botUserIdRaw) : null;
  const maxMessages = Math.max(1, Math.min(20, typeof body.maxMessages === "number" ? Math.trunc(body.maxMessages) : 5));

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
  if (!msgList) return json({ ok: false, error: "no_messages_in_read", notified, sessionId, uri }, 200);

  // 4) Dedup & process new messages.
  const latestId = msgList.messages.reduce((mx, m) => Math.max(mx, m.messageId), 0);
  const lastProcessed = await getLastProcessed(ctx, msgList.chatId);

  if (lastProcessed == null && !body.includeBacklog) {
    if (latestId) await setLastProcessed(ctx, msgList.chatId, latestId);
    return json({ ok: true, notified, sessionId, chatTitle, chatId: msgList.chatId, processed: 0, reason: "initialized_cursor" });
  }

  const since = lastProcessed ?? 0;
  const newMsgs = msgList.messages
    .filter((m) => m.messageId > since)
    .filter((m) => (botUserId != null ? m.fromUserId !== botUserId : true))
    .filter((m) => {
      const t = (m.text ?? "").trim();
      const c = (m.caption ?? "").trim();
      const hasText = t.length > 0 || c.length > 0;
      const hasPhoto = !!(m.photoFileId && m.photoFileId.trim());
      return hasText || hasPhoto;
    })
    .sort((a, b) => a.messageId - b.messageId)
    .slice(0, maxMessages);

  if (!newMsgs.length) {
    if (latestId && latestId > since) await setLastProcessed(ctx, msgList.chatId, latestId);
    return json({ ok: true, notified, sessionId, chatTitle, chatId: msgList.chatId, processed: 0, reason: "no_new_messages" });
  }

  const results: unknown[] = [];
  const scopeAndChatKey = `${scopeKey(ctx)}:${msgList.chatId}`;
  const threadFallback = goalThreadFallbackStore();
  let goalThreadId =
    (await getStoredGoalThreadId(ctx, msgList.chatId)) ?? threadFallback.threadByScopeAndChat.get(scopeAndChatKey) ?? null;

  for (const msg of newMsgs) {
    const mealAuto =
      msg.photoFileId && msg.photoFileId.trim()
        ? await analyzeAndLogTelegramMealPhoto({ ctx, chatId: msgList.chatId, msg })
        : null;

    const userFacing = (msg.text ?? msg.caption ?? "").trim();
    let goalRes: { ok: boolean; status: number; error?: string; threadId?: string | null } | null = null;
    if (userFacing.length > 0) {
      goalRes = await runGoalTickFromTelegram({
        reqUrl: req.url,
        ctx,
        chatTitle,
        chatId: msgList.chatId,
        msg,
        langgraphThreadId: goalThreadId,
      });
      if (goalRes.ok && goalRes.threadId && goalRes.threadId !== goalThreadId) {
        goalThreadId = goalRes.threadId;
        threadFallback.threadByScopeAndChat.set(scopeAndChatKey, goalThreadId);
        await storeGoalThreadId(ctx, msgList.chatId, goalThreadId);
      }
    }

    const mealOk = mealAuto == null || mealAuto.ok === true || mealAuto.skipped === true;
    const goalOk = goalRes == null || goalRes.ok;
    const rowOk = mealOk && goalOk;
    results.push({
      messageId: msg.messageId,
      mealAuto,
      goalTick: goalRes,
      ok: rowOk,
      status: rowOk ? 200 : 500,
      threadId: goalRes?.threadId ?? null,
      error:
        mealAuto && mealAuto.ok === false && !mealAuto.skipped
          ? mealAuto.error
          : goalRes && !goalRes.ok
            ? goalRes.error
            : null,
    });
  }

  const newCursor = newMsgs.reduce((mx, m) => Math.max(mx, m.messageId), since);
  if (newCursor > since) await setLastProcessed(ctx, msgList.chatId, newCursor);

  await memoryAppendEvent({
    ctx,
    type: "telegram.goal_tick",
    payload: { chatTitle, uri, sessionId, chatId: msgList.chatId, notified, since, processed: newMsgs.length, results },
  }).catch(() => {});

  return json({
    ok: true,
    notified,
    sessionId,
    chatTitle,
    chatId: msgList.chatId,
    messages: newMsgs,
    processed: newMsgs.length,
    since,
    cursor: newCursor,
    goalLanggraphThreadId: goalThreadId,
    results,
  });
}

