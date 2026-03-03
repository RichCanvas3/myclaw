import { langgraphFetch, langgraphHeaders } from "@/lib/langgraph/server";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? "50");

  const upstream = await langgraphFetch("/threads/search", {
    method: "POST",
    headers: langgraphHeaders(),
    body: JSON.stringify({ limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50 }),
  });

  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
  });
}

export async function POST(): Promise<Response> {
  const upstream = await langgraphFetch("/threads", {
    method: "POST",
    headers: langgraphHeaders(),
    body: JSON.stringify({}),
  });

  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
  });
}

