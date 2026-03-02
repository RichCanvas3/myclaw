export const runtime = "nodejs";

type ActRequest = {
  thread_id?: string | null;
  user_id?: string;
  org_id?: string;
  message: string;
};

function agentBaseUrl(): string {
  return process.env.AGENT_BASE_URL ?? "http://localhost:8000";
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as ActRequest;

  const upstream = await fetch(`${agentBaseUrl()}/agent/act`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  // Pass-through SSE stream.
  const headers = new Headers(upstream.headers);
  headers.set("cache-control", "no-cache");
  headers.set("connection", "keep-alive");

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

