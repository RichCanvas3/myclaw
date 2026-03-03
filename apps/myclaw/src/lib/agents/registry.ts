import type { A2aAgentConfig, A2aAgentId } from "./types";

function normalizeA2aBaseUrl(url: string): string {
  return url.replace(/\/+$/, "").concat("/");
}

export function getA2aRegistry(): Record<A2aAgentId, A2aAgentConfig> {
  // Future: load from D1 / memory service or an admin UI.
  // For now: env-driven with a single default agent.
  const baseUrl =
    process.env.CHURCHCORE_A2A_BASE_URL ?? "https://a2a-gateway-worker.richardpedersen3.workers.dev/a2a/";
  const apiKey = process.env.CHURCHCORE_A2A_API_KEY ?? "";

  const churchcore: A2aAgentConfig = {
    id: "churchcore",
    name: "Churchcore",
    baseUrl: normalizeA2aBaseUrl(baseUrl),
    apiKeyHeader: "x-api-key",
    apiKey,
  };

  return { [churchcore.id]: churchcore };
}

export function getA2aAgent(id: A2aAgentId | undefined): A2aAgentConfig {
  const registry = getA2aRegistry();
  const agent = registry[id ?? "churchcore"] ?? registry["churchcore"];
  if (!agent) throw new Error("No A2A agents configured");
  if (!agent.apiKey) throw new Error("Missing CHURCHCORE_A2A_API_KEY");
  return agent;
}

