export type McpServerId = string;

export type McpServerConfig = {
  id: McpServerId;
  name: string;
  url: string; // full /mcp URL
  apiKeyHeader: string; // x-api-key
  apiKey: string;
};

export function getMcpRegistry(): Record<McpServerId, McpServerConfig> {
  const apiKey = process.env.GYM_MCP_API_KEY ?? "";

  const weatherUrl = process.env.GYM_WEATHER_MCP_URL ?? "https://gym-weather-mcp.richardpedersen3.workers.dev/mcp";
  const sendgridUrl = process.env.GYM_SENDGRID_MCP_URL ?? "https://gym-sendgrid-mcp.richardpedersen3.workers.dev/mcp";
  const googleCalUrl =
    process.env.GYM_GOOGLECALENDAR_MCP_URL ?? "https://gym-googlecalendar-mcp.richardpedersen3.workers.dev/mcp";
  const telegramUrl =
    process.env.GYM_TELEGRAM_MCP_URL ?? "https://gym-telegram-mcp.richardpedersen3.workers.dev/mcp";
  const weightUrl =
    process.env.GYM_WEIGHT_MCP_URL ?? "https://gym-weight-management-mcp.richardpedersen3.workers.dev/mcp";
  const coreUrl =
    process.env.GYM_CORE_MCP_URL ?? "https://gym-core-mcp.richardpedersen3.workers.dev/mcp";

  return {
    "gym-weather": {
      id: "gym-weather",
      name: "Gym Weather MCP",
      url: weatherUrl,
      apiKeyHeader: "x-api-key",
      apiKey,
    },
    "gym-sendgrid": {
      id: "gym-sendgrid",
      name: "Gym SendGrid MCP",
      url: sendgridUrl,
      apiKeyHeader: "x-api-key",
      apiKey,
    },
    "gym-googlecalendar": {
      id: "gym-googlecalendar",
      name: "Gym Google Calendar MCP",
      url: googleCalUrl,
      apiKeyHeader: "x-api-key",
      apiKey,
    },
    "gym-telegram": {
      id: "gym-telegram",
      name: "Gym Telegram MCP",
      url: telegramUrl,
      apiKeyHeader: "x-api-key",
      apiKey,
    },
    "gym-weight": {
      id: "gym-weight",
      name: "Gym Weight Management MCP",
      url: weightUrl,
      apiKeyHeader: "x-api-key",
      apiKey,
    },
    "gym-core": {
      id: "gym-core",
      name: "Gym Core MCP",
      url: coreUrl,
      apiKeyHeader: "x-api-key",
      apiKey,
    },
  };
}

export function getMcpServer(id: McpServerId): McpServerConfig {
  const reg = getMcpRegistry();
  const s = reg[id];
  if (!s) throw new Error(`Unknown MCP server: ${id}`);
  if (!s.apiKey) throw new Error("Missing GYM_MCP_API_KEY");
  return s;
}

