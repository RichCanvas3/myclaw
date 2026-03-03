function deploymentUrl(): string {
  const url = process.env.LANGGRAPH_DEPLOYMENT_URL;
  if (!url) throw new Error("Missing LANGGRAPH_DEPLOYMENT_URL");
  return url.replace(/\/+$/, "");
}

function apiKey(): string | null {
  return process.env.LANGGRAPH_API_KEY ?? process.env.LANGSMITH_API_KEY ?? null;
}

export function langgraphHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const key = apiKey();
  if (key) headers["x-api-key"] = key;
  return headers;
}

export async function langgraphFetch(path: string, init: RequestInit): Promise<Response> {
  const url = deploymentUrl() + path;
  return fetch(url, init);
}

