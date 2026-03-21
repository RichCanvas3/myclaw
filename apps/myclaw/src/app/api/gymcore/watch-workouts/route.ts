import type { OrchestratorContext } from "@/lib/agents/types";
import { mcpToolsCall } from "@/lib/mcp/client";
import { logMyclaw } from "@/lib/observability";
import { memoryGet, memoryUpsert } from "@/lib/memory/client";
import { resolveTelegramChatIdByTitle } from "@/lib/telegram/resolve";

export const runtime = "nodejs";

type WatchWorkoutsRequest = {
  churchId?: string;
  userId?: string;
  personId?: string;
  householdId?: string | null;
  chatTitle?: string; // default: Smart Agent
  includeBacklog?: boolean;
  limit?: number; // default 25
  // If set, only post workouts with endedAt > sinceEndedAtISO (testing/backfill).
  sinceEndedAtISO?: string;
};

type WorkoutRow = {
  workoutId: string;
  source?: string | null;
  device?: string | null;
  activityType?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  durationSeconds?: number | null;
  distanceMeters?: number | null;
  activeEnergyKcal?: number | null;
  metadata?: Record<string, unknown> | null;
  createdAtISO?: string | null;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function normStr(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}

function safeJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return v;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function defaultCtx(body: WatchWorkoutsRequest): OrchestratorContext {
  const churchId = (body.churchId ?? process.env.MYCLAW_TELEGRAM_DEFAULT_CHURCH_ID ?? "t_cust_casey").toString();
  const userId = (body.userId ?? process.env.MYCLAW_TELEGRAM_DEFAULT_USER_ID ?? "acct_cust_casey").toString();
  const personId = (body.personId ?? process.env.MYCLAW_TELEGRAM_DEFAULT_PERSON_ID ?? "p_casey").toString();
  const householdId = (body.householdId ?? process.env.MYCLAW_TELEGRAM_DEFAULT_HOUSEHOLD_ID ?? "hh_casey") || null;
  return { churchId, userId, personId, householdId, threadId: "gymcore:watch-workouts" };
}

function cursorKey(chatId: string): string {
  return `gymcore:lastWorkoutEndedAt:${chatId}`;
}

async function getCursor(ctx: OrchestratorContext, chatId: string): Promise<string | null> {
  const key = cursorKey(chatId);
  const resp = await memoryGet({ ctx, namespace: "threads", key }).catch(() => null);
  if (!isRecord(resp) || !isRecord(resp.value)) return null;
  const v = resp.value as Record<string, unknown>;
  const endedAt = normStr(v.endedAtISO);
  return endedAt;
}

async function setCursor(ctx: OrchestratorContext, chatId: string, endedAtISO: string): Promise<void> {
  const key = cursorKey(chatId);
  await memoryUpsert({
    ctx,
    namespace: "threads",
    key,
    value: { endedAtISO, updatedAtISO: new Date().toISOString() },
  }).catch(() => {});
}

function formatDuration(sec: number | null | undefined): string | null {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return null;
  const s = Math.trunc(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}h${m.toString().padStart(2, "0")}m`;
  return `${m}m${ss.toString().padStart(2, "0")}s`;
}

function formatDistance(meters: number | null | undefined): string | null {
  if (meters == null || !Number.isFinite(meters) || meters <= 0) return null;
  const km = meters / 1000;
  return `${km.toFixed(km >= 10 ? 1 : 2)} km`;
}

function workoutLine(w: WorkoutRow): string {
  const type = normStr(w.activityType) ?? "workout";
  const dur = formatDuration(w.durationSeconds);
  const dist = formatDistance(w.distanceMeters);
  const kcal = typeof w.activeEnergyKcal === "number" && Number.isFinite(w.activeEnergyKcal) ? `${Math.round(w.activeEnergyKcal)} kcal` : null;
  const ended = normStr(w.endedAt) ?? normStr(w.createdAtISO) ?? "";
  const name =
    w.metadata && typeof w.metadata === "object" && w.metadata !== null && typeof (w.metadata as any).name === "string"
      ? String((w.metadata as any).name).trim()
      : null;
  const bits = [name ? `"${name}"` : null, type, dist, dur, kcal].filter((x): x is string => !!x && x.trim().length > 0);
  return `• ${bits.join(" | ")}${ended ? ` (ended ${ended})` : ""}`;
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as WatchWorkoutsRequest;
  const ctx = defaultCtx(body);

  const chatTitle = (body.chatTitle ?? process.env.MYCLAW_TELEGRAM_WATCH_CHAT_TITLE ?? "Smart Agent").toString();
  const chatIdOverride = (process.env.MYCLAW_TELEGRAM_WATCH_CHAT_ID ?? "").trim();
  const chatId = chatIdOverride || (await resolveTelegramChatIdByTitle(chatTitle).catch(() => null));
  if (!chatId) return json({ ok: false, error: `could_not_resolve_chat_title:${chatTitle}` }, 200);

  const limit = typeof body.limit === "number" && Number.isFinite(body.limit) ? Math.max(1, Math.min(100, Math.trunc(body.limit))) : 25;
  const listRaw = await mcpToolsCall("gym-core", "core_list_workouts", { limit });
  const parsed = safeJson(listRaw);
  const workouts = isRecord(parsed) && Array.isArray(parsed.workouts) ? (parsed.workouts as unknown[]) : [];

  const rows: WorkoutRow[] = [];
  for (const w of workouts) {
    if (!isRecord(w)) continue;
    const id = normStr(w.workoutId);
    if (!id) continue;
    rows.push({
      workoutId: id,
      source: normStr(w.source),
      device: normStr(w.device),
      activityType: normStr(w.activityType),
      startedAt: normStr(w.startedAt),
      endedAt: normStr(w.endedAt),
      durationSeconds: typeof w.durationSeconds === "number" ? w.durationSeconds : null,
      distanceMeters: typeof w.distanceMeters === "number" ? w.distanceMeters : null,
      activeEnergyKcal: typeof w.activeEnergyKcal === "number" ? w.activeEnergyKcal : null,
      metadata: isRecord(w.metadata) ? (w.metadata as Record<string, unknown>) : null,
      createdAtISO: normStr(w.createdAtISO),
    });
  }

  // Determine cursor.
  const overrideSince = normStr(body.sinceEndedAtISO);
  const storedCursor = await getCursor(ctx, chatId);
  const cursor = overrideSince ?? storedCursor;

  // We treat endedAt as the primary monotonic signal.
  const endedMs = (iso: string | null): number => {
    if (!iso) return 0;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : 0;
  };
  const cursorMs = cursor ? endedMs(cursor) : 0;

  const newest = rows.reduce((mx, r) => Math.max(mx, endedMs(r.endedAt)), 0);
  if (!cursor && body.includeBacklog !== true) {
    if (newest) await setCursor(ctx, chatId, new Date(newest).toISOString());
    return json({ ok: true, chatId, chatTitle, posted: 0, reason: "initialized_cursor" }, 200);
  }

  const newOnes = rows
    .filter((r) => endedMs(r.endedAt) > cursorMs)
    .sort((a, b) => endedMs(a.endedAt) - endedMs(b.endedAt))
    .slice(0, 12);

  if (!newOnes.length) {
    if (newest && newest > cursorMs) await setCursor(ctx, chatId, new Date(newest).toISOString());
    return json({ ok: true, chatId, chatTitle, posted: 0, reason: "no_new_workouts" }, 200);
  }

  const header = `New workouts (${newOnes.length}):`;
  const lines = [header, ...newOnes.map(workoutLine)].join("\n");
  await mcpToolsCall("gym-telegram", "telegram_send_message", { chatId, text: lines });

  const postedCursor = Math.max(...newOnes.map((w) => endedMs(w.endedAt)));
  if (postedCursor) await setCursor(ctx, chatId, new Date(postedCursor).toISOString());

  logMyclaw("gymcore-watch", "posted workouts to telegram", { chatId, count: newOnes.length });
  return json({ ok: true, chatId, chatTitle, posted: newOnes.length, newestEndedAtISO: new Date(postedCursor).toISOString() }, 200);
}

