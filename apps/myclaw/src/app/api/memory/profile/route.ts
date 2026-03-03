import { memoryGetProfile } from "@/lib/memory/client";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const churchId = url.searchParams.get("churchId") ?? "calvarybible";
  const userId = url.searchParams.get("userId") ?? "demo_user_noah";
  const personId = url.searchParams.get("personId") ?? "p_seeker_2";
  const householdId = url.searchParams.get("householdId");

  try {
    const profile = await memoryGetProfile({ churchId, userId, personId, householdId, threadId: null });
    return new Response(JSON.stringify(profile ?? null), { status: 200, headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(`Memory error: ${(e as Error).message}`, { status: 500 });
  }
}

