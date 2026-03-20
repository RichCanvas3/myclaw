import type { OrchestratorContext } from "@/lib/agents/types";
import { mcpResourcesList, mcpResourcesRead, mcpResourcesSubscribe, mcpToolsCall } from "@/lib/mcp/client";
import { memoryAppendEvent, memoryGet, memoryUpsert } from "@/lib/memory/client";
import { logMyclaw } from "@/lib/observability";
import {
  hydrateWeightAnalyzeMealPhotoFromTelegram,
  telegramBotTokenForFileFetch,
  validateWeightAnalyzeMealPhotoArgs,
} from "@/lib/telegram/fetchFile";
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
  // Ops/testing: override lastProcessed cursor (process messages with messageId > sinceMessageId).
  sinceMessageId?: number;
  // Safety: cap number of messages processed per call.
  maxMessages?: number;
  // When true, post nutrition summary back to Telegram via telegram_send_message.
  postToTelegram?: boolean;
};

type TelegramMsg = {
  messageId: number;
  fromUserId?: number | null;
  text?: string | null;
  caption?: string | null;
  dateUnix?: number | null;
  /** Largest photo file_id when MCP exposes photos[] / photo / document. */
  photoFileId?: string | null;
  /** Public image URL from telegram-mcp (preferred; avoids bot tokens). */
  imageUrl?: string | null;
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

type MealPhotoState = {
  analysisId?: string;
  summary?: string;
  mealTotals?: { calories?: number; protein_g?: number; carbs_g?: number; fat_g?: number };
  confidence?: number | null;
  postedAtISO?: string;
  updatedAtISO?: string;
};

async function getMealPhotoState(ctx: OrchestratorContext, chatId: string, messageId: number): Promise<MealPhotoState | null> {
  const key = mealPhotoProcessedKey(chatId, messageId);
  const resp = await memoryGet({ ctx, namespace: "threads", key }).catch(() => null);
  if (!isRecord(resp) || !isRecord(resp.value)) return null;
  return resp.value as MealPhotoState;
}

async function wasMealPhotoAlreadyProcessed(ctx: OrchestratorContext, chatId: string, messageId: number): Promise<boolean> {
  const v = await getMealPhotoState(ctx, chatId, messageId);
  return !!(v && typeof v.analysisId === "string" && v.analysisId.trim());
}

async function markMealPhotoProcessed(
  ctx: OrchestratorContext,
  chatId: string,
  messageId: number,
  next: MealPhotoState,
): Promise<void> {
  const key = mealPhotoProcessedKey(chatId, messageId);
  await memoryUpsert({
    ctx,
    namespace: "threads",
    key,
    value: { ...next, updatedAtISO: new Date().toISOString() },
  }).catch(() => {});
}

function numOrNull(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v;
}

function fmt0(n: number | null | undefined): string {
  if (n == null) return "?";
  return String(Math.round(n));
}

function dateISOFromTelegram(msg: TelegramMsg): string {
  const u = typeof msg.dateUnix === "number" && Number.isFinite(msg.dateUnix) ? Math.trunc(msg.dateUnix) : null;
  if (!u) return new Date().toISOString().slice(0, 10);
  return new Date(u * 1000).toISOString().slice(0, 10);
}

function composeTelegramNutritionText(params: {
  messageId: number;
  analysisId: string;
  mealTotals: { calories?: number; protein_g?: number; carbs_g?: number; fat_g?: number };
  confidence?: number | null;
  daySummary?: {
    totals?: { calories?: number; protein_g?: number; carbs_g?: number; fat_g?: number };
    targets?: { calories?: number; protein_g?: number; carbs_g?: number; fat_g?: number } | null;
    dateISO?: string;
  } | null;
}): string {
  const t = params.mealTotals ?? {};
  const mealLine =
    `Meal photo (msg ${params.messageId}): ` +
    `${fmt0(numOrNull(t.calories))} kcal | P ${fmt0(numOrNull(t.protein_g))}g C ${fmt0(numOrNull(t.carbs_g))}g F ${fmt0(numOrNull(t.fat_g))}g` +
    (params.confidence != null && Number.isFinite(params.confidence) ? ` (conf ${params.confidence.toFixed(2)})` : "");

  const ds = params.daySummary;
  const totals = ds?.totals ?? null;
  const targets = ds?.targets ?? null;
  const dayLine =
    totals && targets && (targets.calories || targets.protein_g || targets.carbs_g || targets.fat_g)
      ? `Today (${ds?.dateISO ?? "UTC"}): ` +
        `${fmt0(numOrNull(totals.calories))}/${fmt0(numOrNull(targets.calories))} kcal | ` +
        `P ${fmt0(numOrNull(totals.protein_g))}/${fmt0(numOrNull(targets.protein_g))}g ` +
        `C ${fmt0(numOrNull(totals.carbs_g))}/${fmt0(numOrNull(targets.carbs_g))}g ` +
        `F ${fmt0(numOrNull(totals.fat_g))}/${fmt0(numOrNull(targets.fat_g))}g`
      : totals
        ? `Today (${ds?.dateISO ?? "UTC"}): ${fmt0(numOrNull(totals.calories))} kcal so far`
        : null;

  let remainingLine: string | null = null;
  if (totals && targets) {
    const remK =
      numOrNull(targets.calories) != null && numOrNull(totals.calories) != null ? targets.calories! - totals.calories! : null;
    const remP =
      numOrNull(targets.protein_g) != null && numOrNull(totals.protein_g) != null ? targets.protein_g! - totals.protein_g! : null;
    const remC =
      numOrNull(targets.carbs_g) != null && numOrNull(totals.carbs_g) != null ? targets.carbs_g! - totals.carbs_g! : null;
    const remF =
      numOrNull(targets.fat_g) != null && numOrNull(totals.fat_g) != null ? targets.fat_g! - totals.fat_g! : null;
    if (remK != null || remP != null || remC != null || remF != null) {
      remainingLine = `Remaining: ${fmt0(remK)} kcal | P ${fmt0(remP)}g C ${fmt0(remC)}g F ${fmt0(remF)}g`;
    }
  }

  const lines = [mealLine, dayLine, remainingLine, `analysisId=${params.analysisId}`].filter(
    (x): x is string => typeof x === "string" && x.trim().length > 0,
  );
  return lines.join("\n");
}

/**
 * Vision + D1: wm_meal_analyses + wm_food_entries (aggregate) for each new Telegram photo in the watch feed.
 */
async function analyzeAndLogTelegramMealPhoto(params: {
  ctx: OrchestratorContext;
  chatId: string;
  msg: TelegramMsg;
  postToTelegram: boolean;
}): Promise<{ ok: boolean; skipped?: boolean; error?: string; analysisId?: string }> {
  const imgUrl = normStr(params.msg.imageUrl);
  const fid = (params.msg.photoFileId ?? "").trim();
  if (!imgUrl && !fid) {
    logMyclaw("watch-goal", "meal photo skip: no imageUrl/fileId on message", { messageId: params.msg.messageId });
    return { ok: false, skipped: true, error: "no_photo_source" };
  }

  const existing = await getMealPhotoState(params.ctx, params.chatId, params.msg.messageId);
  const existingId = existing && typeof existing.analysisId === "string" ? existing.analysisId.trim() : "";
  const alreadyPosted = !!(existing && typeof existing.postedAtISO === "string" && existing.postedAtISO.trim());
  if (existingId) {
    if (params.postToTelegram && !alreadyPosted) {
      try {
        const dateISO = dateISOFromTelegram(params.msg);
        const dayRaw = await mcpToolsCall("gym-weight", "weight_day_summary", {
          scope: {
            churchId: params.ctx.churchId,
            userId: params.ctx.userId,
            personId: params.ctx.personId,
            ...(params.ctx.householdId ? { householdId: params.ctx.householdId } : {}),
          },
          dateISO,
        });
        const day = safeJson(dayRaw);
        const text = composeTelegramNutritionText({
          messageId: params.msg.messageId,
          analysisId: existingId,
          mealTotals: existing.mealTotals ?? {},
          confidence: existing.confidence ?? null,
          daySummary: isRecord(day)
            ? {
                totals: isRecord(day.totals) ? (day.totals as any) : undefined,
                targets: (isRecord(day.targets) ? (day.targets as any) : null) as any,
                dateISO: typeof day.dateISO === "string" ? day.dateISO : dateISO,
              }
            : null,
        });
        await mcpToolsCall("gym-telegram", "telegram_send_message", { chatId: params.chatId, text });
        await markMealPhotoProcessed(params.ctx, params.chatId, params.msg.messageId, {
          ...(existing ?? {}),
          analysisId: existingId,
          postedAtISO: new Date().toISOString(),
        });
      } catch (e) {
        logMyclaw("watch-goal", "meal photo post-to-telegram error", {
          messageId: params.msg.messageId,
          error: (e as Error).message,
        });
      }
    }
    logMyclaw("watch-goal", "meal photo skip: already analyzed", {
      chatId: params.chatId,
      messageId: params.msg.messageId,
    });
    return { ok: true, skipped: true, analysisId: existingId };
  }

  if (!imgUrl && !telegramBotTokenForFileFetch()) {
    logMyclaw(
      "watch-goal",
      "meal photo: no MYCLAW_TELEGRAM_BOT_TOKEN and no message imageUrl — forwarding fileId; gym-weight needs TELEGRAM_BOT_TOKEN",
      { chatId: params.chatId },
    );
  }

  logMyclaw("watch-goal", "meal photo pipeline start", {
    chatId: params.chatId,
    messageId: params.msg.messageId,
    ...(imgUrl ? { imageUrl: imgUrl.slice(0, 140) } : { fileIdPrefix: `${fid.slice(0, 12)}…` }),
  });

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
    ...(imgUrl ? { imageUrl: imgUrl } : {}),
    telegram: {
      ...(imgUrl ? {} : { fileId: fid }),
      chatId: params.chatId,
      messageId: params.msg.messageId,
    },
  };

  try {
    await hydrateWeightAnalyzeMealPhotoFromTelegram(args);
    validateWeightAnalyzeMealPhotoArgs(args);
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

    const mealTotals = isRecord(parsed) && isRecord(parsed.analysis) && isRecord((parsed.analysis as any).totals)
      ? {
          calories: numOrNull(((parsed.analysis as any).totals as any).calories) ?? undefined,
          protein_g: numOrNull(((parsed.analysis as any).totals as any).protein_g) ?? undefined,
          carbs_g: numOrNull(((parsed.analysis as any).totals as any).carbs_g) ?? undefined,
          fat_g: numOrNull(((parsed.analysis as any).totals as any).fat_g) ?? undefined,
        }
      : {};
    const conf =
      isRecord(parsed) && isRecord(parsed.analysis) ? numOrNull((parsed.analysis as any).confidence) : null;
    const summary = isRecord(parsed) && typeof parsed.summary === "string" ? parsed.summary : null;

    const baseState: MealPhotoState = {
      analysisId,
      ...(summary ? { summary } : {}),
      mealTotals,
      confidence: conf,
    };

    // Persist analysis state first so we won't duplicate the D1 writes if posting fails.
    await markMealPhotoProcessed(params.ctx, params.chatId, params.msg.messageId, baseState);

    if (params.postToTelegram) {
      const dateISO = dateISOFromTelegram(params.msg);
      const dayRaw = await mcpToolsCall("gym-weight", "weight_day_summary", { scope, dateISO }).catch(() => null);
      const day = dayRaw ? safeJson(dayRaw) : null;
      const text = composeTelegramNutritionText({
        messageId: params.msg.messageId,
        analysisId,
        mealTotals,
        confidence: conf,
        daySummary: day && isRecord(day)
          ? {
              totals: isRecord(day.totals) ? (day.totals as any) : undefined,
              targets: (isRecord(day.targets) ? (day.targets as any) : null) as any,
              dateISO: typeof day.dateISO === "string" ? day.dateISO : dateISO,
            }
          : null,
      });
      await mcpToolsCall("gym-telegram", "telegram_send_message", { chatId: params.chatId, text });
      await markMealPhotoProcessed(params.ctx, params.chatId, params.msg.messageId, {
        ...baseState,
        postedAtISO: new Date().toISOString(),
      });
    }

    logMyclaw("watch-goal", "meal photo pipeline ok", { analysisId, messageId: params.msg.messageId });
    return { ok: true, analysisId };
  } catch (e) {
    logMyclaw("watch-goal", "meal photo pipeline error", {
      messageId: params.msg.messageId,
      error: (e as Error).message,
    });
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
    const imageUrl =
      normStr(m.imageUrl) ||
      (isRecord(m.image)
        ? normStr((m.image as Record<string, unknown>).imageUrl) || normStr((m.image as Record<string, unknown>).url)
        : null);
    out.push({
      messageId,
      fromUserId: typeof m.fromUserId === "number" ? m.fromUserId : null,
      dateUnix: typeof m.dateUnix === "number" ? m.dateUnix : null,
      text: normStr(m.text),
      caption: normStr(m.caption),
      photoFileId: photoFileId ?? null,
      imageUrl,
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
  const storedLastProcessed = await getLastProcessed(ctx, msgList.chatId);
  const overrideSince =
    typeof body.sinceMessageId === "number" && Number.isFinite(body.sinceMessageId) ? Math.trunc(body.sinceMessageId) : null;
  const lastProcessed = overrideSince != null ? overrideSince : storedLastProcessed;

  const postRequested = body.postToTelegram !== false;
  // Backfill runs should not spam Telegram by default. If caller pins sinceMessageId, allow posting.
  const isBackfill = !!body.includeBacklog && overrideSince == null;
  const postToTelegram = postRequested && !isBackfill;

  if (lastProcessed == null && !body.includeBacklog && overrideSince == null) {
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
      const hasPhoto = !!((m.photoFileId && m.photoFileId.trim()) || (m.imageUrl && m.imageUrl.trim()));
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
        ? await analyzeAndLogTelegramMealPhoto({ ctx, chatId: msgList.chatId, msg, postToTelegram })
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

