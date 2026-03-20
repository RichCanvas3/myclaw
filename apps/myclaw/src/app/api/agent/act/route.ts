import { getA2aAgent } from "@/lib/agents/registry";
import type { SuggestedAction } from "@/lib/agents/types";
import { mcpToolsCall, mcpToolsList } from "@/lib/mcp/client";
import { orchestratorCompose, orchestratorComposeEmail, orchestratorPlan } from "@/lib/orchestrator/llm";
import { memoryAppendEvent, memoryGet, memoryGetProfile, memoryQuery, memoryUpsert } from "@/lib/memory/client";
import { normStr, resolveTelegramChatIdByTitle } from "@/lib/telegram/resolve";

export const runtime = "nodejs";

type ActRequest = {
  thread_id?: string | null;
  user_id?: string;
  org_id?: string;
  church_id?: string;
  person_id?: string;
  household_id?: string;
  message: string;
};

function langgraphDeploymentUrl(): string | null {
  return process.env.LANGGRAPH_DEPLOYMENT_URL ?? null;
}

function langgraphApiKey(): string | null {
  return process.env.LANGGRAPH_API_KEY ?? process.env.LANGSMITH_API_KEY ?? null;
}

function langgraphAssistantId(): string {
  return process.env.LANGGRAPH_ASSISTANT_ID ?? "myclaw_agent";
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function envBool(name: string, defaultValue: boolean): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return defaultValue;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function goalTelegramChatTitle(): string {
  const v = (process.env.MYCLAW_GOAL_TELEGRAM_CHAT_TITLE ?? process.env.MYCLAW_TELEGRAM_WATCH_CHAT_TITLE ?? "Smart Agent").trim();
  return v || "Smart Agent";
}

/** Goal-tick context used headings that looked like tool names; planners sometimes hallucinated them as MCP tools. */
async function normalizeTelegramPlannerToolName(
  tool: string,
  args: Record<string, unknown>,
): Promise<{ tool: string; args: Record<string, unknown> }> {
  const aliases = new Set(["telegramRecent", "telegram_recent", "telegram_recent_messages"]);
  if (!aliases.has(tool)) return { tool, args };
  const next = { ...args };
  const hasChatId =
    typeof next.chatId === "string" || (typeof next.chatId === "number" && Number.isFinite(next.chatId));
  if (!hasChatId) {
    const title = goalTelegramChatTitle();
    const cid = await resolveTelegramChatIdByTitle(title).catch(() => null);
    if (cid) next.chatId = cid;
  }
  if (next.limit == null) next.limit = 20;
  return { tool: "telegram_list_messages", args: next };
}

async function postGoalUpdateToTelegram(text: string): Promise<void> {
  const enabled = envBool("MYCLAW_GOAL_TELEGRAM_POST_RESULTS", true);
  if (!enabled) return;
  const chatTitle = goalTelegramChatTitle();
  const chatId = await resolveTelegramChatIdByTitle(chatTitle).catch(() => null);
  if (!chatId) return;
  const trimmed = text.length > 3500 ? text.slice(0, 3500) + "…" : text;
  await mcpToolsCall("gym-telegram", "telegram_send_message", { chatId, text: trimmed }).catch(() => {});
}

function extractCalendarLink(resp: unknown): string | null {
  const parsed = safeJson(resp);
  if (!isRecord(parsed)) return null;
  const ev = (parsed as any).event;
  if (isRecord(ev) && typeof (ev as any).htmlLink === "string" && (ev as any).htmlLink.trim()) return (ev as any).htmlLink.trim();
  if (typeof (parsed as any).htmlLink === "string" && (parsed as any).htmlLink.trim()) return (parsed as any).htmlLink.trim();
  return null;
}

function looksLikeGoogleCalendarNotFound(resp: unknown): boolean {
  // Our MCP client unwraps tool results to a text string, so detect common failure text.
  if (typeof resp === "string") {
    const t = resp.toLowerCase();
    const op = t.includes("events.insert failed") || t.includes("events.update failed") || t.includes("events.delete failed");
    return op && t.includes("\"notfound\"") && t.includes("\"code\":404");
  }
  if (!isRecord(resp)) return false;
  const s = JSON.stringify(resp);
  return /notFound/i.test(s) && /"code"\s*:\s*404/.test(s);
}

function extractCalendarEventInfo(resp: unknown): {
  eventId: string | null;
  htmlLink: string | null;
  summary: string | null;
  startISO: string | null;
  endISO: string | null;
} {
  const parsed = safeJson(resp);
  if (!isRecord(parsed)) return { eventId: null, htmlLink: null, summary: null, startISO: null, endISO: null };
  const ev = (parsed as any).event;
  const obj = isRecord(ev) ? (ev as any) : (parsed as any);
  const eventId = typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : null;
  const htmlLink = typeof obj.htmlLink === "string" && obj.htmlLink.trim() ? obj.htmlLink.trim() : null;
  const summary = typeof obj.summary === "string" && obj.summary.trim() ? obj.summary.trim() : null;
  const start = obj.start;
  const end = obj.end;
  const startISO =
    normalizeIsoMaybe(isRecord(start) ? (start as any).dateTime ?? (start as any).date : null) ?? normalizeIsoMaybe(obj.startISO);
  const endISO =
    normalizeIsoMaybe(isRecord(end) ? (end as any).dateTime ?? (end as any).date : null) ?? normalizeIsoMaybe(obj.endISO);
  return { eventId, htmlLink, summary, startISO, endISO };
}

function extractActiveGoalText(memoryProfile: unknown): string | null {
  if (!isRecord(memoryProfile) || !isRecord(memoryProfile.profile)) return null;
  const goals = (memoryProfile.profile as Record<string, unknown>).goals;
  if (!isRecord(goals)) return null;
  const active = goals.active;
  if (!isRecord(active)) return null;
  const text = active.text;
  return typeof text === "string" && text.trim() ? text.trim() : null;
}

/** Plan steps + eventIds for goal tick / calendar update-delete (not shown in UI). */
function summarizeActiveGoalPlan(memoryProfile: unknown): string {
  if (!isRecord(memoryProfile) || !isRecord(memoryProfile.profile)) return "";
  const goals = (memoryProfile.profile as Record<string, unknown>).goals;
  if (!isRecord(goals)) return "";
  const active = goals.active;
  if (!isRecord(active)) return "";
  const plan = active.plan;
  if (!Array.isArray(plan) || !plan.length) return "";
  const lines: string[] = [];
  for (const st of plan.slice(0, 20)) {
    if (!isRecord(st)) continue;
    const id = typeof st.id === "string" ? st.id : "";
    const title = typeof st.title === "string" ? st.title.trim() : "";
    const whenISO = typeof st.whenISO === "string" ? st.whenISO.trim() : "";
    const eventId = typeof st.eventId === "string" ? st.eventId.trim() : "";
    if (!title && !whenISO && !eventId) continue;
    lines.push(
      `- ${[id ? `step=${id}` : "", eventId ? `eventId=${eventId}` : "", whenISO ? `when=${whenISO}` : "", title ? `title=${title}` : ""].filter(Boolean).join(" | ")}`,
    );
  }
  return lines.join("\n");
}

function safeJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return v;
  }
}

function calendarItemEventId(it: Record<string, unknown>): string | null {
  const raw =
    (typeof it.id === "string" && it.id) ||
    (typeof it.eventId === "string" && it.eventId) ||
    (isRecord(it.resource) && typeof it.resource.id === "string" && it.resource.id) ||
    null;
  const s = raw?.trim();
  return s || null;
}

function normalizeEventSummaryForDedupe(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9\s:-]/g, "")
    .trim();
}

function summarizeCalendarEvents(resp: unknown): string {
  const parsed = safeJson(resp);
  if (!isRecord(parsed)) return "";
  const items =
    (Array.isArray((parsed as any).items) ? ((parsed as any).items as unknown[]) : null) ??
    (Array.isArray((parsed as any).events) ? ((parsed as any).events as unknown[]) : null) ??
    (Array.isArray((parsed as any).events?.items) ? ((parsed as any).events.items as unknown[]) : null);
  if (!items || !items.length) return "";
  const lines: string[] = [];
  for (const it of items.slice(0, 40)) {
    if (!isRecord(it)) continue;
    const summary = typeof (it as any).summary === "string" ? (it as any).summary : "";
    const start = (it as any).start;
    const when =
      (isRecord(start) && typeof (start as any).dateTime === "string" && (start as any).dateTime) ||
      (isRecord(start) && typeof (start as any).date === "string" && (start as any).date) ||
      (typeof (it as any).startISO === "string" ? (it as any).startISO : "") ||
      "";
    if (!summary && !when) continue;
    const eid = calendarItemEventId(it as Record<string, unknown>);
    lines.push(`${eid ? `eventId=${eid} | ` : ""}${when} — ${summary}`.trim());
  }
  return lines.join("\n");
}

function normalizeIsoMaybe(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  const ms = Date.parse(t);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function parseCalendarItems(resp: unknown): Array<{
  eventId: string | null;
  summary: string;
  startISO: string | null;
  endISO: string | null;
}> {
  const parsed = safeJson(resp);
  if (!isRecord(parsed)) return [];
  const items =
    (Array.isArray((parsed as any).items) ? ((parsed as any).items as unknown[]) : null) ??
    (Array.isArray((parsed as any).events) ? ((parsed as any).events as unknown[]) : null) ??
    (Array.isArray((parsed as any).events?.items) ? ((parsed as any).events.items as unknown[]) : null);
  if (!items) return [];
  const out: Array<{ eventId: string | null; summary: string; startISO: string | null; endISO: string | null }> = [];
  for (const it of items) {
    if (!isRecord(it)) continue;
    const rec = it as Record<string, unknown>;
    const eventId = calendarItemEventId(rec);
    const summary = typeof (it as any).summary === "string" ? ((it as any).summary as string).trim() : "";
    const start = (it as any).start;
    const end = (it as any).end;
    const startISO =
      normalizeIsoMaybe(isRecord(start) ? (start as any).dateTime ?? (start as any).date : null) ??
      normalizeIsoMaybe((it as any).startISO);
    const endISO =
      normalizeIsoMaybe(isRecord(end) ? (end as any).dateTime ?? (end as any).date : null) ??
      normalizeIsoMaybe((it as any).endISO);
    if (!summary && !startISO) continue;
    out.push({ eventId, summary, startISO, endISO });
  }
  return out;
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

async function shouldSkipCreateEventDueToDuplicate(args: Record<string, unknown>): Promise<boolean> {
  // Best-effort: if we can list events in a narrow window and find a same-summary overlap, skip.
  const accountAddress = typeof args.accountAddress === "string" ? args.accountAddress : null;
  const summary = typeof args.summary === "string" ? args.summary.trim() : "";
  const startISO = typeof args.startISO === "string" ? args.startISO : null;
  const endISO = typeof args.endISO === "string" ? args.endISO : null;
  if (!accountAddress || !summary || !startISO || !endISO) return false;
  const startMs = Date.parse(startISO);
  const endMs = Date.parse(endISO);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return false;

  const padMs = 2 * 60 * 60 * 1000;
  const timeMinISO = new Date(startMs - padMs).toISOString();
  const timeMaxISO = new Date(endMs + padMs).toISOString();
  const listed = await mcpToolsCall("gym-googlecalendar", "googlecalendar_list_events", {
    accountAddress,
    timeMinISO,
    timeMaxISO,
    maxResults: 50,
  });
  const items = parseCalendarItems(listed);
  const wantNorm = normalizeEventSummaryForDedupe(summary);
  for (const it of items) {
    if (!it.summary) continue;
    if (normalizeEventSummaryForDedupe(it.summary) !== wantNorm) continue;
    const itStart = it.startISO ? Date.parse(it.startISO) : NaN;
    const itEnd = it.endISO ? Date.parse(it.endISO) : NaN;
    if (!Number.isFinite(itStart) || !Number.isFinite(itEnd)) continue;
    if (overlaps(startMs, endMs, itStart, itEnd)) return true;
  }
  return false;
}

async function updateActiveGoalPlanWithCalendarEvent(params: {
  ctx: { churchId: string; userId: string; personId: string; householdId?: string | null; threadId: string };
  event: { eventId: string; htmlLink: string | null; summary: string | null; startISO: string | null; endISO: string | null };
  actionArgs: Record<string, unknown>;
}) {
  const { event } = params;
  if (!event.eventId) return;
  const cur = await memoryGet({ ctx: params.ctx, namespace: "goals", key: "active" }).catch(() => null);
  const curVal = isRecord(cur) && isRecord(cur.value) ? (cur.value as Record<string, unknown>) : null;
  if (!curVal) return;
  const plan = Array.isArray((curVal as any).plan) ? ((curVal as any).plan as unknown[]) : null;
  if (!plan) return;

  const stepWhen = event.startISO;
  const stepTitle = event.summary ?? (typeof params.actionArgs.summary === "string" ? params.actionArgs.summary : null);

  const newPlan: unknown[] = [];
  let changed = false;
  for (const st of plan) {
    if (!isRecord(st)) {
      newPlan.push(st);
      continue;
    }
    const title = typeof (st as any).title === "string" ? ((st as any).title as string).trim() : "";
    const whenISO = typeof (st as any).whenISO === "string" ? ((st as any).whenISO as string).trim() : "";
    const existingEventId = typeof (st as any).eventId === "string" ? ((st as any).eventId as string).trim() : "";

    const titleMatch = stepTitle ? title.toLowerCase() === stepTitle.toLowerCase() : false;
    const whenMatch =
      stepWhen && whenISO
        ? Math.abs(Date.parse(whenISO) - Date.parse(stepWhen)) <= 10 * 60 * 1000
        : false;

    if (!existingEventId && (whenMatch || titleMatch)) {
      const next = { ...(st as any), eventId: event.eventId, calendarLink: event.htmlLink ?? (st as any).calendarLink };
      newPlan.push(next);
      changed = true;
    } else {
      newPlan.push(st);
    }
  }

  if (!changed) return;
  const nextGoal = { ...curVal, plan: newPlan };
  await memoryUpsert({ ctx: params.ctx, namespace: "goals", key: "active", value: nextGoal }).catch(() => {});
}

function summarizeTelegramMessages(resp: unknown): string {
  const parsed = safeJson(resp);
  if (!isRecord(parsed)) return "";
  const messages = Array.isArray((parsed as any).messages) ? ((parsed as any).messages as unknown[]) : null;
  if (!messages || !messages.length) return "";
  const lines: string[] = [];
  for (const m of messages.slice(0, 8)) {
    if (!isRecord(m)) continue;
    const messageId = typeof (m as any).messageId === "number" ? (m as any).messageId : null;
    const text = typeof (m as any).text === "string" ? (m as any).text.trim() : "";
    if (!text) continue;
    lines.push(`- msg#${messageId ?? ""}: ${text}`.trim());
  }
  return lines.join("\n");
}

async function buildGoalContext(memoryProfile: unknown): Promise<string> {
  const pieces: string[] = [];
  const nowISO = new Date().toISOString();
  pieces.push(`nowISO: ${nowISO}`);
  const goalText = extractActiveGoalText(memoryProfile);
  if (goalText) pieces.push(`activeGoal: ${goalText}`);
  const planLines = summarizeActiveGoalPlan(memoryProfile);
  if (planLines) pieces.push(`goalPlan (use eventId for update/delete; do not re-create):\n${planLines}`);

  // Calendar "observe": next 21 days with eventIds (for dedupe / reschedule in goal tick).
  try {
    const addr = resolveCalendarAccountAddressFromProfile(memoryProfile);
    if (addr) {
      const t0 = new Date();
      const t1 = new Date(t0.getTime() + 21 * 24 * 60 * 60 * 1000);
      const cal = await mcpToolsCall("gym-googlecalendar", "googlecalendar_list_events", {
        accountAddress: addr,
        timeMinISO: t0.toISOString(),
        timeMaxISO: t1.toISOString(),
        maxResults: 50,
      });
      const s = summarizeCalendarEvents(cal);
      if (s) {
        pieces.push(
          `observation_google_calendar_21d (read-only snapshot; NOT an MCP tool — use googlecalendar_list_events to query):\n${s}`,
        );
      }
    }
  } catch {
    // ignore
  }

  // Telegram "observe": recent messages in Smart Agent (best-effort).
  try {
    const title = goalTelegramChatTitle();
    const chatId = await resolveTelegramChatIdByTitle(title).catch(() => null);
    if (chatId) {
      const msgs = await mcpToolsCall("gym-telegram", "telegram_list_messages", { chatId, limit: 10 });
      const s = summarizeTelegramMessages(msgs);
      if (s) {
        pieces.push(
          `observation_telegram_chat_lines (read-only snippet; NOT an MCP tool — use telegram_list_messages with chatId ${chatId}):\n${s}`,
        );
      }
    }
  } catch {
    // ignore
  }

  return pieces.join("\n\n");
}

async function upsertGoalObservation(ctx: { churchId: string; userId: string; personId: string; householdId?: string | null; threadId: string }, obs: unknown) {
  try {
    const cur = await memoryGet({ ctx, namespace: "goals", key: "active" }).catch(() => null);
    const curVal = isRecord(cur) && isRecord(cur.value) ? (cur.value as Record<string, unknown>) : null;
    if (!curVal) return;
    const next = { ...curVal, last_observation: obs };
    await memoryUpsert({ ctx, namespace: "goals", key: "active", value: next }).catch(() => {});
  } catch {
    // ignore
  }
}

function isA2aCallActionWithEndpoint(action: SuggestedAction, endpoint: string): boolean {
  if (action.type !== "a2a.call") return false;
  const input = action.input as unknown;
  return isRecord(input) && input.endpoint === endpoint;
}

function householdMemberNames(v: unknown): string[] {
  if (!isRecord(v)) return [];
  const members = v.members;
  if (!Array.isArray(members)) return [];
  const names: string[] = [];
  for (const m of members) {
    if (!isRecord(m)) continue;
    const first = typeof m.first_name === "string" ? m.first_name : typeof m.firstName === "string" ? m.firstName : "";
    const last = typeof m.last_name === "string" ? m.last_name : typeof m.lastName === "string" ? m.lastName : "";
    const full = `${first} ${last}`.trim();
    if (full) names.push(full);
  }
  return names;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function defaultCalendarAccountAddress(): string | null {
  const v = process.env.MYCLAW_DEFAULT_GCAL_ACCOUNT_ADDRESS ?? "";
  return v.trim() ? v.trim() : null;
}

function resolveCalendarAccountAddressFromProfile(memoryProfile: unknown): string | null {
  const identity =
    isRecord(memoryProfile) && isRecord(memoryProfile.profile) && isRecord(memoryProfile.profile.identity)
      ? (memoryProfile.profile.identity as Record<string, unknown>)
      : null;
  const addr =
    (identity && typeof identity.googlecalendar_accountAddress === "string" ? identity.googlecalendar_accountAddress : null) ||
    (identity && typeof identity.calendar_accountAddress === "string" ? identity.calendar_accountAddress : null) ||
    defaultCalendarAccountAddress();
  return addr && addr.trim() ? addr.trim() : null;
}

function requireStringArg(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new Error(`Missing required argument: ${key}`);
  return v;
}

function coerceString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s : null;
}

/** Parse planner/wire dates to UTC ISO; date-only YYYY-MM-DD → noon UTC (timed event). */
function canonicalizeCalendarInstant(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const dateOnly = /^(\d{4}-\d{2}-\d{2})$/.exec(t);
  const ms = dateOnly ? Date.parse(`${dateOnly[1]}T12:00:00.000Z`) : Date.parse(t);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * Google Calendar patch often 400s on "Invalid start time" when start/end are inconsistent,
 * end <= start, or only one side is sent for a timed event. Align to a valid UTC pair.
 */
function finalizeGoogleCalendarStartEndPair(args: Record<string, unknown>, tool: "create" | "update"): void {
  const hasStartRaw = coerceString(args.startISO) != null;
  const hasEndRaw = coerceString(args.endISO) != null;
  if (!hasStartRaw && !hasEndRaw) return;

  let startS = hasStartRaw ? canonicalizeCalendarInstant(String(args.startISO)) : null;
  let endS = hasEndRaw ? canonicalizeCalendarInstant(String(args.endISO)) : null;

  const durationRaw = args.durationMinutes;
  const durationMs =
    typeof durationRaw === "number" && Number.isFinite(durationRaw) && durationRaw > 0
      ? Math.round(durationRaw) * 60 * 1000
      : 60 * 60 * 1000;

  if (startS && !endS) {
    endS = new Date(Date.parse(startS) + durationMs).toISOString();
  }
  if (endS && !startS) {
    startS = new Date(Date.parse(endS) - durationMs).toISOString();
  }
  if (!startS || !endS) {
    throw new Error(
      `${tool === "create" ? "googlecalendar_create_event" : "googlecalendar_update_event"}: invalid or unparseable startISO/endISO (Google expects valid instants, typically as RFC3339).`,
    );
  }
  let startMs = Date.parse(startS);
  let endMs = Date.parse(endS);
  if (endMs <= startMs) {
    endMs = startMs + Math.max(durationMs, 60 * 1000);
    endS = new Date(endMs).toISOString();
  }
  args.startISO = startS;
  args.endISO = endS;

  // Avoid workers forwarding both flat ISO and nested start/end objects.
  delete args.start;
  delete args.end;
}

function normalizeGoogleCalendarArgs(tool: string, args: Record<string, unknown>) {
  const isCreate = tool === "googlecalendar_create_event";
  const isUpdate = tool === "googlecalendar_update_event";
  const isDelete = tool === "googlecalendar_delete_event";
  if (!isCreate && !isUpdate && !isDelete) return;

  // Common alternate field names emitted by planners.
  if (isCreate || isUpdate) {
    args.summary ??= args.title ?? args.name ?? args.task ?? args.what;
    const startAlt = args.start ?? args.startTime ?? args.start_time ?? args.startDateTime ?? args.whenStart;
    const endAlt = args.end ?? args.endTime ?? args.end_time ?? args.endDateTime ?? args.whenEnd;
    if (args.startISO == null && startAlt != null) args.startISO = startAlt as unknown;
    if (args.endISO == null && endAlt != null) args.endISO = endAlt as unknown;
  }
  if (isUpdate || isDelete) {
    args.eventId ??= args.id ?? args.event_id ?? args.eventID;
  }

  // Ensure they're strings (not objects like {dateTime: "..."}).
  if (isCreate || isUpdate) {
    const summary = coerceString(args.summary);
    if (summary) args.summary = summary;

    const start =
      coerceString(args.startISO) ?? coerceString((args.startISO as any)?.dateTime) ?? coerceString((args.startISO as any)?.date);
    if (start) args.startISO = start;

    const end =
      coerceString(args.endISO) ?? coerceString((args.endISO as any)?.dateTime) ?? coerceString((args.endISO as any)?.date);
    if (end) args.endISO = end;
  }
  if (isUpdate || isDelete) {
    const eventId = coerceString(args.eventId);
    if (eventId) args.eventId = eventId;
  }

  // If durationMinutes is present, derive endISO from startISO.
  if (isCreate || isUpdate) {
    const durationRaw = args.durationMinutes;
    if (!coerceString(args.endISO) && typeof durationRaw === "number" && Number.isFinite(durationRaw)) {
      const startCanon = args.startISO ? canonicalizeCalendarInstant(String(args.startISO)) : null;
      if (startCanon) {
        args.startISO = startCanon;
        args.endISO = new Date(Date.parse(startCanon) + Math.round(durationRaw) * 60 * 1000).toISOString();
      }
    }
  }

  // Never schedule in the past: shift forward in whole weeks (preserves weekday/time).
  if (isCreate) {
    const startMs = Date.parse(String(args.startISO ?? ""));
    const endMs = Date.parse(String(args.endISO ?? ""));
    if (Number.isFinite(startMs)) {
      const nowMs = Date.now();
      const thresholdMs = nowMs - 5 * 60 * 1000; // tolerate slight clock skew
      if (startMs < thresholdMs) {
        const weekMs = 7 * 24 * 60 * 60 * 1000;
        const addWeeks = Math.min(520, Math.max(1, Math.ceil((nowMs - startMs) / weekMs)));
        const durMs = Number.isFinite(endMs) && endMs > startMs ? endMs - startMs : 60 * 60 * 1000;
        const newStart = startMs + addWeeks * weekMs;
        args.startISO = new Date(newStart).toISOString();
        args.endISO = new Date(newStart + durMs).toISOString();
      }
    }
  }

  if (isCreate) {
    const hasTimes = coerceString(args.startISO) != null || coerceString(args.endISO) != null;
    if (hasTimes) finalizeGoogleCalendarStartEndPair(args, "create");
  } else if (isUpdate) {
    const hasAnyTime = coerceString(args.startISO) != null || coerceString(args.endISO) != null;
    if (hasAnyTime) finalizeGoogleCalendarStartEndPair(args, "update");
  }
}

/** For /goal tick: list/freebusy → delete → update → create; other action types keep their relative order. */
function sortGoalTickGoogleCalendarActions(actions: SuggestedAction[]): SuggestedAction[] {
  const indexed = actions.map((action, i) => ({ action, i }));
  const calRank = (a: SuggestedAction): number => {
    if (a.type !== "mcp.tool" || !isRecord(a.input) || a.input.server !== "gym-googlecalendar") return -1;
    const tool = a.input.tool;
    if (tool === "googlecalendar_list_calendars" || tool === "googlecalendar_get_connection_status") return 0;
    if (tool === "googlecalendar_list_events" || tool === "googlecalendar_freebusy") return 1;
    if (tool === "googlecalendar_delete_event") return 2;
    if (tool === "googlecalendar_update_event") return 3;
    if (tool === "googlecalendar_create_event") return 4;
    return 2;
  };
  return indexed
    .sort((a, b) => {
      const ra = calRank(a.action);
      const rb = calRank(b.action);
      if (ra >= 0 && rb >= 0 && ra !== rb) return ra - rb;
      return a.i - b.i;
    })
    .map((x) => x.action);
}

function validateGoogleCalendarArgs(tool: string, args: Record<string, unknown>) {
  if (tool === "googlecalendar_create_event") {
    const missing: string[] = [];
    for (const k of ["summary", "startISO", "endISO"] as const) {
      const v = args[k];
      if (typeof v !== "string" || !v.trim()) missing.push(k);
    }
    if (missing.length) {
      throw new Error(
        `Invalid googlecalendar_create_event args: missing ${missing.join(", ")}. ` +
          `Provide summary/startISO/endISO (or use title/start/end/durationMinutes and the server will normalize).`,
      );
    }
  }
  if (tool === "googlecalendar_update_event") {
    if (typeof args.eventId !== "string" || !args.eventId.trim()) {
      throw new Error("Invalid googlecalendar_update_event args: missing eventId.");
    }
  }
  if (tool === "googlecalendar_delete_event") {
    if (typeof args.eventId !== "string" || !args.eventId.trim()) {
      throw new Error("Invalid googlecalendar_delete_event args: missing eventId.");
    }
  }
}

function defaultWeatherLatLon(): { lat: number; lon: number } | null {
  const latRaw = (process.env.MYCLAW_DEFAULT_WEATHER_LAT ?? "").trim();
  const lonRaw = (process.env.MYCLAW_DEFAULT_WEATHER_LON ?? "").trim();
  if (!latRaw || !lonRaw) return null;
  const lat = Number(latRaw);
  const lon = Number(lonRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

async function executeCalendarRange(params: {
  accountAddress: string;
  timeMinISO: string;
  timeMaxISO: string;
  query?: string;
}): Promise<unknown> {
  // Chunk into 7-day windows to avoid googlecalendar_list_events maxResults=50.
  const start = Date.parse(params.timeMinISO);
  const end = Date.parse(params.timeMaxISO);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error("Invalid calendar time range");
  }

  const results: unknown[] = [];
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  for (let t = start; t < end; t += weekMs) {
    const t2 = Math.min(end, t + weekMs);
    const resp = await mcpToolsCall("gym-googlecalendar", "googlecalendar_list_events", {
      accountAddress: params.accountAddress,
      timeMinISO: new Date(t).toISOString(),
      timeMaxISO: new Date(t2).toISOString(),
      ...(params.query ? { q: params.query } : {}),
      maxResults: 50,
    });
    const text = typeof resp === "string" ? resp : JSON.stringify(resp, null, 2);
    results.push(tryParseJson(text));
  }
  return { accountAddress: params.accountAddress, timeMinISO: params.timeMinISO, timeMaxISO: params.timeMaxISO, windows: results };
}

function extractOutputMessage(v: unknown): string | null {
  // We look for any nested shape like { output: { message: string } }.
  const stack: unknown[] = [v];
  let steps = 0;
  while (stack.length && steps < 2000) {
    steps++;
    const cur = stack.pop();
    if (!cur) continue;

    if (Array.isArray(cur)) {
      for (const item of cur) stack.push(item);
      continue;
    }

    if (!isRecord(cur)) continue;

    const out = cur.output;
    if (isRecord(out) && typeof out.message === "string" && out.message.trim()) {
      return out.message;
    }

    for (const val of Object.values(cur)) stack.push(val);
  }
  return null;
}

function extractSuggestedActions(v: unknown): SuggestedAction[] | null {
  const stack: unknown[] = [v];
  let steps = 0;
  while (stack.length && steps < 2000) {
    steps++;
    const cur = stack.pop();
    if (!cur) continue;

    if (Array.isArray(cur)) {
      for (const item of cur) stack.push(item);
      continue;
    }

    if (!isRecord(cur)) continue;

    const sa = cur.suggestedActions;
    if (Array.isArray(sa)) {
      const parsed: SuggestedAction[] = [];
      for (const item of sa) {
        if (!isRecord(item)) continue;
        if (typeof item.type !== "string") continue;
        parsed.push({ type: item.type, input: isRecord(item.input) ? item.input : undefined });
      }
      return parsed;
    }

    for (const val of Object.values(cur)) stack.push(val);
  }
  return null;
}

function parseSseChunk(buffer: string): { events: Array<{ event: string; data: unknown }>; rest: string } {
  const events: Array<{ event: string; data: unknown }> = [];
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? "";

  for (const part of parts) {
    const lines = part.split(/\r?\n/);
    const eventLine = lines.find((l) => l.startsWith("event: "));
    const dataLine = lines.find((l) => l.startsWith("data: "));
    if (!eventLine || !dataLine) continue;

    const event = eventLine.slice("event: ".length).trim();
    const raw = dataLine.slice("data: ".length).trim();
    try {
      events.push({ event, data: JSON.parse(raw) as unknown });
    } catch {
      // ignore
    }
  }

  return { events, rest };
}

function extractDeltaLike(obj: unknown): string | null {
  // Common shapes:
  // - {"delta":"..."} / {"text":"..."} / {"message":"..."}
  // - {"data":{"delta":"..."}} etc.
  const stack: unknown[] = [obj];
  let steps = 0;
  while (stack.length && steps < 2000) {
    steps++;
    const cur = stack.pop();
    if (!cur) continue;
    if (typeof cur === "string" && cur.trim()) return cur;
    if (Array.isArray(cur)) {
      for (const it of cur) stack.push(it);
      continue;
    }
    if (!isRecord(cur)) continue;
    for (const k of ["delta", "text", "message", "content"]) {
      const v = cur[k];
      if (typeof v === "string" && v.trim()) return v;
    }
    for (const v of Object.values(cur)) stack.push(v);
  }
  return null;
}

async function a2aChatStream(params: {
  agent: string | undefined;
  endpoint: string;
  payload: Record<string, unknown>;
  onDelta: (text: string) => void;
}): Promise<void> {
  const agent = getA2aAgent(params.agent);

  const res = await fetch(`${agent.baseUrl}${params.endpoint}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream, application/json",
      [agent.apiKeyHeader]: agent.apiKey,
    },
    body: JSON.stringify(params.payload),
  });

  if (!res.ok || !res.body) {
    throw new Error(`A2A ${params.endpoint} failed: ${res.status} - ${await res.text()}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? "";
    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const raw = trimmed.slice("data:".length).trim();
      if (!raw) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(raw) as unknown;
      } catch {
        continue;
      }
      if (isRecord(obj)) {
        const t = extractDeltaLike(obj);
        if (t) params.onDelta(t);
      }
    }
  }
}

async function a2aCallJson(params: {
  agent: string | undefined;
  endpoint: string;
  payload: Record<string, unknown>;
}): Promise<unknown> {
  const agent = getA2aAgent(params.agent);

  const res = await fetch(`${agent.baseUrl}${params.endpoint}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      [agent.apiKeyHeader]: agent.apiKey,
    },
    body: JSON.stringify(params.payload),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`A2A ${params.endpoint} failed: ${res.status} - ${text}`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function normalizeAction(action: SuggestedAction): { kind: "a2a.call"; agent?: string; endpoint: string; stream: boolean; payload: Record<string, unknown> } | null {
  if (action.type !== "a2a.call") return null;
  const input = action.input;
  const endpoint = typeof input?.endpoint === "string" ? input.endpoint : null;
  const payload = isRecord(input?.payload) ? input.payload : null;
  const streamFlag = input?.stream;
  const agent = typeof input?.agent === "string" ? input.agent : undefined;
  if (!endpoint || !payload) return null;
  const stream =
    (typeof streamFlag === "boolean" ? streamFlag : endpoint.endsWith(".stream")) ||
    endpoint.endsWith(".stream");
  return { kind: "a2a.call", agent, endpoint, stream, payload };
}

async function ensureA2aThread(params: {
  agent: string | undefined;
  session: { churchId: string; userId: string; personId: string; householdId?: string | null };
  ctx: { churchId: string; userId: string; personId: string; householdId?: string | null; threadId: string };
}): Promise<string> {
  const agentId = params.agent ?? "churchcore";
  // Use a sticky per-user mapping (not per myclaw thread/topic) so Churchcore stays in a single
  // conversational thread for the connected user by default.
  const mapKey = `a2a:${agentId}:user:${params.session.churchId}:${params.session.userId}:${params.session.personId}`;

  const existing = await memoryGet({ ctx: params.ctx, namespace: "threads", key: mapKey });
  if (isRecord(existing) && isRecord(existing.value) && typeof existing.value.thread_id === "string") {
    return existing.value.thread_id;
  }

  // Create A2A thread (best-effort). If memory isn’t configured, this will still work
  // for the current request but won’t persist across server restarts.
  const identity = {
    tenant_id: params.session.churchId,
    user_id: params.session.userId,
    person_id: params.session.personId,
    household_id: params.session.householdId ?? null,
  };
  const payload = { identity, title: `myclaw:${agentId}` };

  const resp = await a2aCallJson({ agent: agentId, endpoint: "thread.create", payload });
  const tid = isRecord(resp) && typeof resp.thread_id === "string" ? resp.thread_id : null;
  if (!tid) throw new Error("Failed to create A2A thread");

  try {
    await memoryUpsert({ ctx: params.ctx, namespace: "threads", key: mapKey, value: { thread_id: tid } });
  } catch {
    // ignore (memory not configured or transient error)
  }

  return tid;
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as ActRequest;
  const direct = body.message?.trim?.() ?? "";
  const directGoal = direct.startsWith("/goal ");
  const directGoalTickish = direct.startsWith("/goal tick") || direct.startsWith("/goal run");

  const deploymentUrl = langgraphDeploymentUrl();
  if (!deploymentUrl) {
    if (directGoal) {
      const msg =
        "Goal autonomy requires LangGraph (LangSmith/LangServe) to be configured.\n\n" +
        "Set these in the myclaw web app env:\n" +
        "- LANGGRAPH_DEPLOYMENT_URL\n" +
        "- LANGGRAPH_API_KEY\n\n" +
        "And set these on the LangGraph deployment env (so /goal tick can plan):\n" +
        "- ORCH_OPENAI_API_KEY (and optionally ORCH_OPENAI_MODEL / ORCH_OPENAI_BASE_URL)\n";
      const encoder = new TextEncoder();
      const out = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(sse("thread", { thread_id: body.thread_id ?? "new" })));
          controller.enqueue(encoder.encode(sse("delta", { text: msg })));
          controller.enqueue(encoder.encode(sse("final", { thread_id: body.thread_id ?? "new", message: msg, entities: [], suggestedActions: [] })));
          controller.close();
        },
      });
      return new Response(out, {
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
      });
    }
    return new Response("Missing LANGGRAPH_DEPLOYMENT_URL", { status: 500 });
  }

  const apiKey = langgraphApiKey();
  if (directGoal && !apiKey) {
    const msg =
      "Goal autonomy requires LangGraph API auth.\n\n" +
      "Set LANGGRAPH_API_KEY in the myclaw web app env, then retry.";
    const encoder = new TextEncoder();
    const out = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sse("thread", { thread_id: body.thread_id ?? "new" })));
        controller.enqueue(encoder.encode(sse("delta", { text: msg })));
        controller.enqueue(encoder.encode(sse("final", { thread_id: body.thread_id ?? "new", message: msg, entities: [], suggestedActions: [] })));
        controller.close();
      },
    });
    return new Response(out, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    });
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;

  // Ensure thread exists in LangGraph Agent Server.
  let threadId = body.thread_id ?? null;
  if (!threadId) {
    const tRes = await fetch(`${deploymentUrl}/threads`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    if (!tRes.ok) {
      return new Response(await tRes.text(), { status: tRes.status });
    }
    const tJson = (await tRes.json()) as { thread_id?: string };
    threadId = tJson.thread_id ?? null;
  }
  if (!threadId) return new Response("Failed to create thread", { status: 500 });

  // Shortcut: allow direct MCP calls from the UI without needing a redeploy of the LangSmith director.
  // Format:
  // - /mcp <server> <tool> [<json_args>]
  // - /mcp-tools <server>
  if (direct.startsWith("/mcp-tools ")) {
    const server = direct.replace("/mcp-tools ", "").trim();
    const encoder = new TextEncoder();
    const out = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(sse("thread", { thread_id: threadId })));
        try {
          const res = await mcpToolsList(server);
          const rendered = typeof res === "string" ? res : JSON.stringify(res, null, 2);
          controller.enqueue(encoder.encode(sse("delta", { text: rendered })));
          controller.enqueue(
            encoder.encode(sse("final", { thread_id: threadId, message: rendered, entities: [], suggestedActions: [] })),
          );
        } catch (e) {
          const msg = `MCP error: ${(e as Error).message}`;
          controller.enqueue(encoder.encode(sse("delta", { text: msg })));
          controller.enqueue(
            encoder.encode(sse("final", { thread_id: threadId, message: msg, entities: [], suggestedActions: [] })),
          );
        }
        controller.close();
      },
    });
    return new Response(out, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    });
  }

  if (direct.startsWith("/mcp ")) {
    const rest = direct.replace("/mcp ", "").trim();
    const [server, tool, ...argsParts] = rest.split(" ");
    const argsText = argsParts.join(" ").trim() || "{}";
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(argsText) as unknown;
      if (isRecord(parsed)) args = parsed;
    } catch {
      // ignore
    }
    const encoder = new TextEncoder();
    const out = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(sse("thread", { thread_id: threadId })));
        try {
          const res = await mcpToolsCall(server ?? "", tool ?? "", args);
          const rendered = typeof res === "string" ? res : JSON.stringify(res, null, 2);
          controller.enqueue(encoder.encode(sse("delta", { text: rendered })));
          controller.enqueue(
            encoder.encode(sse("final", { thread_id: threadId, message: rendered, entities: [], suggestedActions: [] })),
          );
        } catch (e) {
          const msg = `MCP error: ${(e as Error).message}`;
          controller.enqueue(encoder.encode(sse("delta", { text: msg })));
          controller.enqueue(
            encoder.encode(sse("final", { thread_id: threadId, message: msg, entities: [], suggestedActions: [] })),
          );
        }
        controller.close();
      },
    });
    return new Response(out, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    });
  }

  const session = {
    churchId: body.church_id ?? body.org_id ?? "calvarybible",
    userId: body.user_id ?? "demo_user_noah",
    personId: body.person_id ?? "p_seeker_2",
    householdId: body.household_id ?? null,
  };

  // Load durable memory profile (if configured). This is *not* stored in LangSmith.
  let memoryProfile: unknown = null;
  try {
    memoryProfile = await memoryGetProfile({ ...session, threadId });
  } catch {
    memoryProfile = null;
  }

  // For goal autonomy, enrich the message with lightweight observation context (calendar + telegram).
  let messageToSend = body.message;
  if (directGoalTickish) {
    const ctxText = await buildGoalContext(memoryProfile).catch(() => "");
    if (ctxText) {
      messageToSend = `${body.message}\n\n[context]\n${ctxText}`;
    }
  }

  // If configured, use an orchestrator LLM to produce action packs (no phrase triggers).
  // Otherwise we fall back to the LangSmith director behavior below.
  const planned = directGoal
    ? null
    : await orchestratorPlan({
        userMessage: body.message,
        session,
        threadId,
        memoryProfile,
        nowISO: new Date().toISOString(),
      });

  // Helpful error when user requests email but orchestrator LLM isn't configured.
  if (!planned && /\bsend\s+email\b/i.test(body.message)) {
    const encoder = new TextEncoder();
    const out = new ReadableStream<Uint8Array>({
      start(controller) {
        const msg =
          "Email sending requires the Next.js orchestrator LLM.\n\n" +
          "Set ORCH_OPENAI_API_KEY (and optionally ORCH_OPENAI_MODEL) in the web app env vars, then try again.\n" +
          "Also ensure the gym-sendgrid-mcp worker has SENDGRID_API_KEY and SENDGRID_FROM_EMAIL configured.";
        controller.enqueue(encoder.encode(sse("thread", { thread_id: threadId })));
        controller.enqueue(encoder.encode(sse("delta", { text: msg })));
        controller.enqueue(
          encoder.encode(sse("final", { thread_id: threadId, message: msg, entities: [], suggestedActions: [] })),
        );
        controller.close();
      },
    });
    return new Response(out, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    });
  }

  if (planned) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(sse("thread", { thread_id: threadId })));

        const toolResults: Array<{ action: SuggestedAction; result: unknown }> = [];
        let accumulated = "";
        const ctx = { ...session, threadId };

        const pendingEmails: Array<{
          action: SuggestedAction;
          to: string[];
          subjectHint?: string;
          textHint?: string;
          includeHousehold?: boolean;
        }> = [];

        for (const action of planned.actions) {
          if (action.type === "email.send" && isRecord(action.input)) {
            const to = Array.isArray(action.input.to) ? action.input.to.filter((x) => typeof x === "string") : [];
            pendingEmails.push({
              action,
              to,
              subjectHint: typeof action.input.subject === "string" ? action.input.subject : undefined,
              textHint: typeof action.input.text === "string" ? action.input.text : undefined,
              includeHousehold: Boolean(action.input.includeHousehold),
            });
            continue;
          }

          if (action.type === "calendar.range" && isRecord(action.input)) {
            try {
              const timeMinISO = typeof action.input.timeMinISO === "string" ? action.input.timeMinISO : null;
              const timeMaxISO = typeof action.input.timeMaxISO === "string" ? action.input.timeMaxISO : null;
              const query = typeof action.input.query === "string" ? action.input.query : undefined;
              const identity =
                isRecord(memoryProfile) && isRecord(memoryProfile.profile) && isRecord(memoryProfile.profile.identity)
                  ? (memoryProfile.profile.identity as Record<string, unknown>)
                  : null;
              const addr =
                (typeof action.input.accountAddress === "string" && action.input.accountAddress) ||
                (identity && typeof identity.googlecalendar_accountAddress === "string"
                  ? identity.googlecalendar_accountAddress
                  : null) ||
                (identity && typeof identity.calendar_accountAddress === "string" ? identity.calendar_accountAddress : null) ||
                defaultCalendarAccountAddress();
              if (!addr)
                throw new Error(
                  "Missing Google Calendar accountAddress (e.g. acct_cust_casey). Set identity.googlecalendar_accountAddress in memory or include accountAddress in the action.",
                );
              if (!timeMinISO || !timeMaxISO) throw new Error("Missing timeMinISO/timeMaxISO");
              const res = await executeCalendarRange({ accountAddress: addr, timeMinISO, timeMaxISO, query });
              toolResults.push({ action, result: res });
            } catch (e) {
              toolResults.push({ action, result: { error: (e as Error).message } });
            }
            continue;
          }
          if (action.type === "memory.upsert" && isRecord(action.input)) {
            try {
              const ns = typeof action.input.namespace === "string" ? action.input.namespace : null;
              const key = typeof action.input.key === "string" ? action.input.key : null;
              if (!ns || !key) throw new Error("Invalid memory.upsert action");
              const res = await memoryUpsert({ ctx, namespace: ns, key, value: action.input.value });
              toolResults.push({ action, result: res });
            } catch (e) {
              toolResults.push({ action, result: { error: (e as Error).message } });
            }
            continue;
          }
          if (action.type === "memory.query" && isRecord(action.input)) {
            try {
              const ns = typeof action.input.namespace === "string" ? action.input.namespace : undefined;
              const q = typeof action.input.q === "string" ? action.input.q : undefined;
              const res = await memoryQuery({ ctx, namespace: ns, q, limit: 50 });
              toolResults.push({ action, result: res });
            } catch (e) {
              toolResults.push({ action, result: { error: (e as Error).message } });
            }
            continue;
          }
          if (action.type === "mcp.tool" && isRecord(action.input)) {
            const server = typeof action.input.server === "string" ? action.input.server : "";
            let tool = typeof action.input.tool === "string" ? action.input.tool : "";
            let args = isRecord(action.input.args) ? { ...action.input.args } : {};
            try {
              if (server === "gym-telegram") {
                const n = await normalizeTelegramPlannerToolName(tool, args);
                tool = n.tool;
                args = n.args;
              }
              // Safety: if the planner accidentally emits a malformed Google Calendar MCP call,
              // rewrite it into a calendar.range default (next 30 days).
              if (
                server === "gym-googlecalendar" &&
                tool === "googlecalendar_list_events" &&
                (!("accountAddress" in args) || !("timeMinISO" in args) || !("timeMaxISO" in args))
              ) {
                const now = new Date();
                const later = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
                const res = await executeCalendarRange({
                  accountAddress: defaultCalendarAccountAddress() ?? "acct_cust_casey",
                  timeMinISO: now.toISOString(),
                  timeMaxISO: later.toISOString(),
                });
                toolResults.push({
                  action: {
                    type: "calendar.range",
                    input: { timeMinISO: now.toISOString(), timeMaxISO: later.toISOString() },
                  },
                  result: res,
                });
                continue;
              }

              // Default weather location (Erie, CO) when missing lat/lon.
              if (server === "gym-weather" && tool.startsWith("weather_")) {
                const hasLat = typeof args.lat === "number" && Number.isFinite(args.lat);
                const hasLon = typeof args.lon === "number" && Number.isFinite(args.lon);
                if (!hasLat || !hasLon) {
                  const def = defaultWeatherLatLon();
                  if (def) {
                    args.lat = def.lat;
                    args.lon = def.lon;
                    args.units ??= "imperial";
                    args.label ??= "Erie, CO";
                  }
                }
              }

              // Default Google Calendar accountAddress when missing.
              if (server === "gym-googlecalendar" && tool.startsWith("googlecalendar_")) {
                const hasAddr = typeof (args as Record<string, unknown>).accountAddress === "string";
                if (!hasAddr) {
                  const addr = resolveCalendarAccountAddressFromProfile(memoryProfile);
                  if (addr) (args as Record<string, unknown>).accountAddress = addr;
                }
                normalizeGoogleCalendarArgs(tool, args as Record<string, unknown>);
                validateGoogleCalendarArgs(tool, args as Record<string, unknown>);
              }

              // Telegram convenience: allow referencing chats by title/username (server resolves to chatId).
              if (server === "gym-telegram") {
                const hasChatId =
                  typeof args.chatId === "string" ||
                  (typeof args.chatId === "number" && Number.isFinite(args.chatId));
                const chatTitle =
                  normStr((args as Record<string, unknown>).chatTitle) ??
                  normStr((args as Record<string, unknown>).title) ??
                  normStr((args as Record<string, unknown>).chatName);
                if (!hasChatId && chatTitle && tool !== "telegram_list_chats") {
                  const resolved = await resolveTelegramChatIdByTitle(chatTitle);
                  if (resolved) {
                    args.chatId = resolved;
                    delete (args as Record<string, unknown>).chatTitle;
                    delete (args as Record<string, unknown>).title;
                    delete (args as Record<string, unknown>).chatName;
                  } else {
                    throw new Error(
                      `Unknown Telegram chat: "${chatTitle}". Try telegram_list_chats first to see available titles/chatIds.`,
                    );
                  }
                }
              }

              const res = await mcpToolsCall(server, tool, args);
              toolResults.push({ action, result: res });
            } catch (e) {
              toolResults.push({ action, result: { error: (e as Error).message } });
            }
            continue;
          }
          if (action.type === "a2a.call") {
            const norm = normalizeAction(action);
            if (!norm) {
              toolResults.push({ action, result: { error: "Invalid a2a.call action" } });
              continue;
            }

            const payload: Record<string, unknown> = { ...norm.payload };
            payload.session = isRecord(payload.session) ? { ...session, ...payload.session } : session;
            payload.identity ??= {
              tenant_id: session.churchId,
              user_id: session.userId,
              person_id: session.personId,
              household_id: session.householdId,
            };

            // Ensure the per-user sticky Churchcore thread exists for endpoints that use it.
            const needsThread = norm.endpoint.startsWith("chat") || norm.endpoint.startsWith("thread");
            if (needsThread && !("thread_id" in payload)) {
              try {
                const tid = await ensureA2aThread({ agent: norm.agent, session, ctx: { ...ctx, threadId } });
                payload.thread_id = tid;
              } catch {
                // ignore
              }
            }

            try {
              if (norm.stream) {
                let text = "";
                await a2aChatStream({
                  agent: norm.agent,
                  endpoint: norm.endpoint,
                  payload,
                  onDelta: (t) => {
                    text += t;
                    controller.enqueue(encoder.encode(sse("delta", { text: t })));
                  },
                });
                toolResults.push({ action, result: { text } });
              } else {
                const res = await a2aCallJson({ agent: norm.agent, endpoint: norm.endpoint, payload });
                toolResults.push({ action, result: res });
              }
            } catch (e) {
              toolResults.push({ action, result: { error: (e as Error).message } });
            }
            continue;
          }
        }

        // Execute pending emails last, so they can include household/tool context.
        if (pendingEmails.length) {
          // Ensure we have household info if requested.
          const needsHousehold = pendingEmails.some((e) => e.includeHousehold);
          if (needsHousehold && !toolResults.some((tr) => isA2aCallActionWithEndpoint(tr.action, "household.get"))) {
            try {
              const payload: Record<string, unknown> = {
                identity: {
                  tenant_id: session.churchId,
                  user_id: session.userId,
                  person_id: session.personId,
                  household_id: session.householdId,
                },
              };
              const res = await a2aCallJson({ agent: "churchcore", endpoint: "household.get", payload });
              toolResults.push({ action: { type: "a2a.call", input: { agent: "churchcore", endpoint: "household.get", stream: false, payload } } as SuggestedAction, result: res });
              // Best-effort persist to local memory.
              try {
                await memoryUpsert({ ctx, namespace: "household", key: "latest", value: res });
              } catch {
                // ignore
              }
            } catch (e) {
              toolResults.push({ action: { type: "a2a.call", input: { agent: "churchcore", endpoint: "household.get", stream: false, payload: {} } } as SuggestedAction, result: { error: (e as Error).message } });
            }
          }

          for (const pe of pendingEmails) {
            const recipients = pe.to
              .flatMap((s) => s.split(/[, ]+/g))
              .map((s) => s.trim())
              .filter(Boolean);
            if (!recipients.length) {
              toolResults.push({ action: pe.action, result: { error: "No recipients" } });
              continue;
            }

            const draft = await orchestratorComposeEmail({
              userMessage: body.message,
              session,
              threadId,
              to: recipients,
              subjectHint: pe.subjectHint,
              textHint: pe.textHint,
              includeHousehold: pe.includeHousehold,
              toolResults,
            });

            // Emit a small preview so the user can verify inclusion.
            const hhResult = toolResults.find((tr) => isA2aCallActionWithEndpoint(tr.action, "household.get"))?.result;
            const hhNames = householdMemberNames(hhResult);
            const preview =
              `Email draft:\nSubject: ${draft.subject}\nTo: ${recipients.join(", ")}\n` +
              (pe.includeHousehold ? `Household members: ${hhNames.length ? hhNames.join(", ") : "(none found)"}\n` : "") +
              `\n${draft.text.slice(0, 600)}${draft.text.length > 600 ? "\n…(truncated)" : ""}`;
            controller.enqueue(encoder.encode(sse("delta", { text: preview })));
            toolResults.push({ action: pe.action, result: { draft, recipients } });

            for (const to of recipients) {
              try {
                const res = await mcpToolsCall("gym-sendgrid", "sendEmail", {
                  to,
                  subject: draft.subject,
                  text: draft.text,
                  ...(draft.html ? { html: draft.html } : {}),
                });
                toolResults.push({ action: pe.action, result: { to, ok: true, response: res } });
              } catch (e) {
                toolResults.push({ action: pe.action, result: { to, ok: false, error: (e as Error).message } });
              }
            }
          }
        }

        try {
          const finalText = await orchestratorCompose({
            userMessage: body.message,
            session,
            threadId,
            toolResults,
          });
          accumulated = finalText;
          controller.enqueue(encoder.encode(sse("delta", { text: finalText })));
        } catch (e) {
          const msg = `Orchestrator error: ${(e as Error).message}`;
          accumulated = msg;
          controller.enqueue(encoder.encode(sse("delta", { text: msg })));
        }

        controller.enqueue(
          encoder.encode(
            sse("final", {
              thread_id: threadId,
              message: accumulated.trim(),
              entities: [],
              suggestedActions: planned.actions,
            }),
          ),
        );
        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    });
  }

  const upstream = await fetch(`${deploymentUrl}/threads/${threadId}/runs/stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      assistant_id: langgraphAssistantId(),
      input: {
        skill: "chat",
        message: messageToSend,
        args: { memory_profile: memoryProfile },
        session: {
          ...session,
          thread_id: threadId,
        },
      },
      stream_mode: ["custom", "updates"],
    }),
  });

  if (!upstream.ok || !upstream.body) {
    return new Response(await upstream.text(), { status: upstream.status });
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let accumulated = "";
  let fallbackMessage: string | null = null;
  let suggestedActions: SuggestedAction[] | null = null;
  const executedActions: SuggestedAction[] = [];
  const calendarLinks: string[] = [];
  const toolErrors: string[] = [];
  let buffer = "";

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(sse("thread", { thread_id: threadId })));

      const reader = upstream.body!.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseChunk(buffer);
        buffer = parsed.rest;

        for (const ev of parsed.events) {
          if (ev.event === "error") {
            // Surface upstream errors to the UI.
            const msg =
              (isRecord(ev.data) && typeof ev.data.message === "string" && ev.data.message) ||
              JSON.stringify(ev.data);
            if (!accumulated) accumulated = msg;
            controller.enqueue(encoder.encode(sse("delta", { text: msg })));
            continue;
          }
          if (ev.event === "custom") {
            const data = ev.data as unknown;
            if (typeof data === "object" && data !== null && "delta" in data) {
              const delta = (data as { delta?: unknown }).delta;
              if (typeof delta === "string") {
                accumulated += delta;
                controller.enqueue(encoder.encode(sse("delta", { text: delta })));
              }
            }
            continue;
          }

          // If we didn't get any custom deltas, LangGraph often still provides output in updates.
          const maybe = extractOutputMessage(ev.data);
          if (maybe) fallbackMessage = maybe;

          const sa = extractSuggestedActions(ev.data);
          if (sa && sa.length) suggestedActions = sa;
        }
      }

      // Orchestrate: execute agent-suggested actions via Next.js (not from LangSmith runtime).
      // Default: if no actions were produced, fall back to whatever message we got.
      const ctx = { ...session, threadId };

      if (suggestedActions && suggestedActions.length) {
        const actionsToRun = directGoalTickish ? sortGoalTickGoogleCalendarActions(suggestedActions) : suggestedActions;
        for (const action of actionsToRun) {
          executedActions.push(action);

          if (action.type === "mcp.tool" && isRecord(action.input)) {
            try {
              const server = typeof action.input.server === "string" ? action.input.server : null;
              let tool = typeof action.input.tool === "string" ? action.input.tool : null;
              let args = isRecord(action.input.args) ? { ...action.input.args } : null;
              if (!server || !tool || !args) throw new Error("Invalid mcp.tool action");

              if (server === "gym-telegram") {
                const n = await normalizeTelegramPlannerToolName(tool, args);
                tool = n.tool;
                args = n.args;
              }

              // Default Google Calendar accountAddress when missing.
              if (server === "gym-googlecalendar" && tool.startsWith("googlecalendar_")) {
                const hasAddr = typeof (args as Record<string, unknown>).accountAddress === "string";
                if (!hasAddr) {
                  const addr = resolveCalendarAccountAddressFromProfile(memoryProfile);
                  if (addr) (args as Record<string, unknown>).accountAddress = addr;
                }
                normalizeGoogleCalendarArgs(tool, args as Record<string, unknown>);
                validateGoogleCalendarArgs(tool, args as Record<string, unknown>);
              }

              // De-dupe calendar creates (best-effort).
              if (server === "gym-googlecalendar" && tool === "googlecalendar_create_event") {
                try {
                  const skip = await shouldSkipCreateEventDueToDuplicate(args as Record<string, unknown>);
                  if (skip) {
                    const resp = { skipped: true, reason: "duplicate_event", args };
                    const rendered = JSON.stringify(resp, null, 2);
                    accumulated ||= rendered;
                    controller.enqueue(encoder.encode(sse("delta", { text: rendered })));
                    continue;
                  }
                } catch {
                  // ignore dedupe failures; proceed with create
                }
              }

              const resp = await mcpToolsCall(server, tool, args);
              if (server === "gym-googlecalendar") {
                const info = extractCalendarEventInfo(resp);
                const link = info.htmlLink ?? extractCalendarLink(resp);
                if (link) calendarLinks.push(link);

                if (tool === "googlecalendar_create_event" && info.eventId) {
                  await updateActiveGoalPlanWithCalendarEvent({
                    ctx,
                    event: info as any,
                    actionArgs: args as Record<string, unknown>,
                  }).catch(() => {});
                }

                if (looksLikeGoogleCalendarNotFound(resp)) {
                  toolErrors.push(
                    "Google Calendar Not Found (404). If using TARGET_CALENDAR_ID, ensure it's set to the calendar *id* (from googlecalendar_list_calendars), not the display name. Also, update/delete require an eventId that exists on that same target calendar.",
                  );
                }
              }
              const rendered = typeof resp === "string" ? resp : JSON.stringify(resp, null, 2);
              accumulated ||= rendered;
              controller.enqueue(encoder.encode(sse("delta", { text: rendered })));
            } catch (e) {
              const msg = `MCP error: ${(e as Error).message}`;
              toolErrors.push(msg);
              accumulated ||= msg;
              controller.enqueue(encoder.encode(sse("delta", { text: msg })));
            }
            continue;
          }

          if (action.type === "calendar.range" && isRecord(action.input)) {
            try {
              const timeMinISO = typeof action.input.timeMinISO === "string" ? action.input.timeMinISO : null;
              const timeMaxISO = typeof action.input.timeMaxISO === "string" ? action.input.timeMaxISO : null;
              const query = typeof action.input.query === "string" ? action.input.query : undefined;

              // IMPORTANT: gym-googlecalendar-mcp expects an accountAddress like "acct_cust_casey",
              // not an email address.
              const identity =
                isRecord(memoryProfile) && isRecord(memoryProfile.profile) && isRecord(memoryProfile.profile.identity)
                  ? (memoryProfile.profile.identity as Record<string, unknown>)
                  : null;

              const addr =
                (typeof action.input.accountAddress === "string" && action.input.accountAddress) ||
                (identity && typeof identity.googlecalendar_accountAddress === "string"
                  ? identity.googlecalendar_accountAddress
                  : null) ||
                (identity && typeof identity.calendar_accountAddress === "string" ? identity.calendar_accountAddress : null) ||
                defaultCalendarAccountAddress();

              if (!addr)
                throw new Error(
                  "Missing Google Calendar accountAddress (e.g. acct_cust_casey). Set identity.googlecalendar_accountAddress in memory or include accountAddress in the action.",
                );
              if (!timeMinISO || !timeMaxISO) throw new Error("Missing timeMinISO/timeMaxISO");

              const resp = await executeCalendarRange({ accountAddress: addr, timeMinISO, timeMaxISO, query });
              const rendered = JSON.stringify(resp, null, 2);
              accumulated ||= rendered;
              controller.enqueue(encoder.encode(sse("delta", { text: rendered })));
            } catch (e) {
              const msg = `Calendar error: ${(e as Error).message}`;
              accumulated ||= msg;
              controller.enqueue(encoder.encode(sse("delta", { text: msg })));
            }
            continue;
          }

          // Durable memory actions (executed by Next.js).
          if (action.type === "memory.upsert" && isRecord(action.input)) {
            try {
              const ns = typeof action.input.namespace === "string" ? action.input.namespace : null;
              const key = typeof action.input.key === "string" ? action.input.key : null;
              if (ns && key) {
                await memoryUpsert({ ctx, namespace: ns, key, value: action.input.value });
                controller.enqueue(encoder.encode(sse("delta", { text: `Saved to memory: ${ns}.${key}` })));
              }
            } catch (e) {
              controller.enqueue(encoder.encode(sse("delta", { text: `Memory error: ${(e as Error).message}` })));
            }
            continue;
          }
          if (action.type === "memory.query" && isRecord(action.input)) {
            try {
              const ns = typeof action.input.namespace === "string" ? action.input.namespace : undefined;
              const q = typeof action.input.q === "string" ? action.input.q : undefined;
              const resp = await memoryQuery({ ctx, namespace: ns, q, limit: 25 });
              const rendered = JSON.stringify(resp, null, 2);
              accumulated ||= rendered;
              controller.enqueue(encoder.encode(sse("delta", { text: rendered })));
            } catch (e) {
              controller.enqueue(encoder.encode(sse("delta", { text: `Memory error: ${(e as Error).message}` })));
            }
            continue;
          }

          const norm = normalizeAction(action);
          if (!norm) continue;

          // Ensure session is always present for gateway calls.
          const payload: Record<string, unknown> = { ...norm.payload };
          payload.session = isRecord(payload.session) ? { ...session, ...payload.session } : session;
          // Churchcore gateway expects these top-level fields for many skills.
          // A2A thread_id is *not* the LangSmith thread id; we map and persist it in memory.
          let a2aThreadId: string | null = null;
          try {
            a2aThreadId = await ensureA2aThread({ agent: norm.agent, session, ctx: { ...ctx, threadId } });
          } catch {
            a2aThreadId = null;
          }
          if (a2aThreadId) payload.thread_id ??= a2aThreadId;
          payload.identity ??= {
            tenant_id: session.churchId,
            user_id: session.userId,
            person_id: session.personId,
            household_id: session.householdId,
          };

          try {
            if (norm.stream) {
              const before = accumulated.length;
              await a2aChatStream({
                agent: norm.agent,
                endpoint: norm.endpoint,
                payload,
                onDelta: (t) => {
                  accumulated += t;
                  controller.enqueue(encoder.encode(sse("delta", { text: t })));
                },
              });
              // If streaming produced nothing, fall back to non-stream endpoint.
              if (accumulated.length === before && norm.endpoint.endsWith(".stream")) {
                const fallbackEndpoint = norm.endpoint.replace(/\.stream$/, "");
                const resp = await a2aCallJson({ agent: norm.agent, endpoint: fallbackEndpoint, payload });
                const rendered = typeof resp === "string" ? resp : JSON.stringify(resp, null, 2);
                accumulated ||= rendered;
                controller.enqueue(encoder.encode(sse("delta", { text: rendered })));
              }
            } else {
              const resp = await a2aCallJson({
                agent: norm.agent,
                endpoint: norm.endpoint,
                payload,
              });
              const rendered = typeof resp === "string" ? resp : JSON.stringify(resp, null, 2);
              accumulated ||= rendered;
              controller.enqueue(encoder.encode(sse("delta", { text: rendered })));
            }
          } catch (e) {
            const msg = `A2A error: ${(e as Error).message}`;
            accumulated ||= msg;
            controller.enqueue(encoder.encode(sse("delta", { text: msg })));
          }
        }
      } else if (accumulated.includes("A2A HTTP 403") || accumulated.includes("error code: 1010")) {
        // Back-compat: if the currently deployed agent still tries to call A2A from LangSmith
        // (and gets blocked), fall back to calling A2A from Next.js.
        accumulated = "";
        try {
          await a2aChatStream({
            agent: "churchcore",
            endpoint: "chat.stream",
            payload: { skill: "chat", message: body.message, args: null, session },
            onDelta: (t) => {
              accumulated += t;
              controller.enqueue(encoder.encode(sse("delta", { text: t })));
            },
          });
        } catch (e) {
          const msg = `A2A error: ${(e as Error).message}`;
          accumulated ||= msg;
          controller.enqueue(encoder.encode(sse("delta", { text: msg })));
        }
      } else if (!accumulated.trim() && fallbackMessage) {
        accumulated = fallbackMessage;
        if (accumulated) controller.enqueue(encoder.encode(sse("delta", { text: accumulated })));
      }

      controller.enqueue(
        encoder.encode(
          sse("final", {
            thread_id: threadId,
            message: accumulated.trim(),
            entities: [],
            suggestedActions: executedActions,
          }),
        ),
      );
      controller.close();

      // Post goal-oriented output to Telegram (best-effort).
      if (directGoal) {
        const lines: string[] = [];
        lines.push("myclaw: goal update");
        lines.push(`cmd: ${body.message.trim().slice(0, 180)}`);
        if (calendarLinks.length) {
          lines.push("calendar:");
          for (const l of calendarLinks.slice(0, 5)) lines.push(`- ${l}`);
        }
        if (toolErrors.length) {
          lines.push("errors:");
          for (const e of toolErrors.slice(0, 5)) lines.push(`- ${e}`);
        }
        const msgText = (fallbackMessage && fallbackMessage.trim()) || accumulated.trim();
        if (msgText) lines.push(`note: ${msgText.slice(0, 600)}`);
        await postGoalUpdateToTelegram(lines.join("\n"));
      }

      // Observe: persist a small observation so the next tick can adapt.
      if (directGoalTickish) {
        await upsertGoalObservation(ctx, {
          atISO: new Date().toISOString(),
          calendarLinks: calendarLinks.slice(0, 10),
          errors: toolErrors.slice(0, 10),
          executedActions: executedActions.slice(0, 20),
        });
      }

      // Audit trail (best-effort).
      try {
        await memoryAppendEvent({
          ctx,
          type: "orchestrator.run",
          payload: {
            threadId,
            input: { message: body.message },
            suggestedActions: suggestedActions ?? [],
            output: { message: accumulated.trim() },
          },
        });
      } catch {
        // ignore
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

