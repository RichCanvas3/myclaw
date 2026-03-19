import type { OrchestratorContext } from "@/lib/agents/types";
import { mcpToolsCall } from "@/lib/mcp/client";
import { memoryGetProfile } from "@/lib/memory/client";

export const runtime = "nodejs";

type SetupRequest = {
  churchId?: string;
  userId?: string;
  personId?: string;
  householdId?: string | null;
  accountAddress?: string;
  calendarName?: string; // default: myclaw
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

function defaultCtx(body: SetupRequest): OrchestratorContext {
  const churchId = (body.churchId ?? process.env.MYCLAW_TELEGRAM_DEFAULT_CHURCH_ID ?? "t_cust_casey").toString();
  const userId = (body.userId ?? process.env.MYCLAW_TELEGRAM_DEFAULT_USER_ID ?? "acct_cust_casey").toString();
  const personId = (body.personId ?? process.env.MYCLAW_TELEGRAM_DEFAULT_PERSON_ID ?? "p_casey").toString();
  const householdId = (body.householdId ?? process.env.MYCLAW_TELEGRAM_DEFAULT_HOUSEHOLD_ID ?? "hh_casey") || null;
  return { churchId, userId, personId, householdId, threadId: "googlecalendar:setup" };
}

function resolveAccountAddress(body: SetupRequest, memoryProfile: unknown): string | null {
  const explicit = normStr(body.accountAddress);
  if (explicit) return explicit;

  const identity =
    isRecord(memoryProfile) && isRecord(memoryProfile.profile) && isRecord(memoryProfile.profile.identity)
      ? (memoryProfile.profile.identity as Record<string, unknown>)
      : null;
  const v =
    (identity && typeof identity.googlecalendar_accountAddress === "string" ? identity.googlecalendar_accountAddress : null) ||
    (identity && typeof identity.calendar_accountAddress === "string" ? identity.calendar_accountAddress : null) ||
    (process.env.MYCLAW_DEFAULT_GCAL_ACCOUNT_ADDRESS ?? null);
  return normStr(v);
}

function parseCalendars(resp: unknown): Array<{ id: string; summary: string }> {
  const parsed = typeof resp === "string" ? (JSON.parse(resp) as unknown) : resp;
  if (!isRecord(parsed) || !Array.isArray((parsed as any).calendars)) return [];
  const out: Array<{ id: string; summary: string }> = [];
  for (const c of (parsed as any).calendars as unknown[]) {
    if (!isRecord(c)) continue;
    const id = normStr((c as any).id);
    const summary = normStr((c as any).summary);
    if (id && summary) out.push({ id, summary });
  }
  return out;
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as SetupRequest;
  const ctx = defaultCtx(body);
  const memoryProfile = await memoryGetProfile(ctx).catch(() => null);

  const accountAddress = resolveAccountAddress(body, memoryProfile);
  if (!accountAddress) return json({ ok: false, error: "missing_accountAddress" }, 400);

  const status = await mcpToolsCall("gym-googlecalendar", "googlecalendar_get_connection_status", { accountAddress }).catch(
    (e) => ({ error: (e as Error).message }),
  );

  const calendarsRaw = await mcpToolsCall("gym-googlecalendar", "googlecalendar_list_calendars", { accountAddress }).catch(
    (e) => ({ error: (e as Error).message }),
  );

  let calendars: Array<{ id: string; summary: string }> = [];
  try {
    calendars = parseCalendars(calendarsRaw);
  } catch {
    calendars = [];
  }

  const wanted = (body.calendarName ?? "myclaw").toString().trim().toLowerCase();
  const matches = calendars.filter((c) => c.summary.toLowerCase() === wanted);

  return json({
    ok: true,
    accountAddress,
    connectionStatus: status,
    calendarName: wanted,
    matches,
    instructions:
      matches.length > 0
        ? `Set TARGET_CALENDAR_ID in the googlecalendar-mcp worker to "${matches[0]!.id}" and redeploy.`
        : `No calendar named "${wanted}" found. Create it in Google Calendar, then retry.`,
  });
}

