# Configuration checklist (myclaw + gym MCPs + LangGraph)

Use this when wiring **local dev**, **Vercel/hosted myclaw**, **each Cloudflare MCP worker**, and **LangSmith / LangGraph**.

---

## 1. myclaw (Next.js) — `.env`

| Area | Variables | Notes |
|------|-----------|--------|
| **MCP clients** | `GYM_MCP_API_KEY`, `GYM_*_MCP_URL` for weather, sendgrid, googlecalendar, telegram, weight | Values must match each worker’s MCP auth + public `/mcp` URL. |
| **Orchestrator** | `ORCH_OPENAI_*` | Planner + composer in `src/lib/orchestrator/llm.ts`; without key, planner falls back / limited. |
| **LangGraph client** | `LANGGRAPH_DEPLOYMENT_URL`, `LANGGRAPH_ASSISTANT_ID`, `LANGGRAPH_API_KEY` | If UI/API calls hosted graph. |
| **Memory** | `MEMORY_API_URL`, `MEMORY_API_KEY` | If using durable memory worker. |
| **Churchcore** | `CHURCHCORE_A2A_*` | If using A2A agent paths. |
| **Calendar default** | `MYCLAW_DEFAULT_GCAL_ACCOUNT_ADDRESS` | `acct_...` when memory has no `googlecalendar_accountAddress`. |
| **Weather default** | `MYCLAW_DEFAULT_WEATHER_LAT`, `MYCLAW_DEFAULT_WEATHER_LON` | When user doesn’t pass location. |
| **Telegram automation** | `MYCLAW_TELEGRAM_*`, `MYCLAW_TELEGRAM_BOT_USER_ID` | **Set bot user id** to avoid reply loops. Defaults for church/user/person/household for pump/watch. |
| **Meal photos → weight MCP** | `MYCLAW_TELEGRAM_BOT_TOKEN` (same bot as telegram-mcp) | myclaw downloads Telegram files and sends `imageBase64` to `weight_analyze_meal_photo` so the weight worker may omit `TELEGRAM_BOT_TOKEN`. |
| **Telegram → email** | `MYCLAW_TELEGRAM_NOTIFY_EMAIL_TO`, watch title, `MYCLAW_TELEGRAM_WATCH_TOKEN` | SendGrid path still needs **SendGrid MCP** configured with real API keys on **that** worker. |

---

## 2. LangSmith / LangGraph deployment (separate from myclaw `.env`)

| Item | Purpose |
|------|---------|
| **`MCP_SERVERS_JSON`** | Register all five servers: `gym-weather`, `gym-sendgrid`, `gym-googlecalendar`, `gym-telegram`, `gym-weight` with same URLs + `x-api-key` as myclaw. Template: [langgraph-mcp-servers.example.json](./langgraph-mcp-servers.example.json). |
| **`MCP_TOOL_ALLOWLIST`** | Union of allowed tools: [MCP_TOOL_ALLOWLIST.md](./MCP_TOOL_ALLOWLIST.md). Match **exact** names your deployment lists (prefix rules vary). |
| **`ORCH_OPENAI_API_KEY`** (or your template’s LLM vars) | Goal tick / planner in `apps/agent/graph.py` needs an LLM; align with LangGraph docs. |
| Redeploy | After any MCP or allowlist change. |

---

## 3. Every gym MCP worker (pattern)

- **`MCP_API_KEY`** (or worker-specific name) = same value you send as **`x-api-key`** from clients (`GYM_MCP_API_KEY`).
- Deployed URL ends with **`/mcp`** and matches `GYM_*_MCP_URL`.
- Worker-specific secrets (below) are **on that worker**, not in myclaw unless docs say otherwise.

---

## 4. gym-weight-management-mcp

| Item | Notes |
|------|--------|
| D1 | Valid `database_id` in `wrangler.toml`; `migrations apply --remote`. |
| Secrets | `MCP_API_KEY`; for photos: `VISION_API_KEY` (+ optional model/base URL); for Telegram file URLs: `TELEGRAM_BOT_TOKEN`. |
| Telegram photos | Ingest/analyze needs `photos[].fileId` in payloads; see `apps/weight-management-mcp/docs/telegram-photos.md`. |

---

## 5. gym-googlecalendar-mcp

| Item | Notes |
|------|--------|
| OAuth / tokens | Per `accountAddress` (e.g. `acct_cust_casey`); user must complete Google connect flow for that worker. |
| Target calendar | Worker env like `TARGET_CALENDAR_ID` must be the **calendar id** from `googlecalendar_list_calendars`, not display name (see errors in `act/route.ts`). |
| myclaw / agent | Pass `accountAddress` on calendar tools or set `MYCLAW_DEFAULT_GCAL_ACCOUNT_ADDRESS` / memory `identity.googlecalendar_accountAddress`. |

---

## 6. gym-telegram-mcp

| Item | Notes |
|------|--------|
| Bot token / session | Whatever that worker requires for Bot API. |
| **Photo metadata** | For weight meal photos, message payloads should include **`photos[]` with `fileId`** (not text-only). |

---

## 7. gym-sendgrid-mcp

| Item | Notes |
|------|--------|
| SendGrid API key | On the sendgrid worker; `sendEmail` from myclaw assumes worker is configured. |

---

## 8. gym-weather-mcp

| Item | Notes |
|------|--------|
| Usually minimal | URL + shared `GYM_MCP_API_KEY`; provider keys if that worker uses a paid weather API. |

---

## 9. Operational pieces (easy to forget)

| Item | Notes |
|------|--------|
| **Cron / scheduled hits** | `POST /api/telegram/pump`, `watch-email`, `watch-goal` only run if something **calls** them (Vercel cron, external scheduler). |
| **HTTPS / prod URL** | MCP URLs must be reachable from **LangGraph servers** (public HTTPS). |
| **Scope for weight** | Tools take `scope` (`churchId`, `userId`, `personId`, …); agent should mirror the user/session identity Telegram/myclaw uses. |

---

## 10. Quick validation

1. **`weight_ping`** / **`telegram_ping`** / **`weather_current`** via MCP with `x-api-key`.
2. myclaw: open UI path that triggers `mcpToolsCall` or hit an API route that uses registry.
3. LangGraph: run a thread that lists tools and invokes one tool per MCP you care about.

If one MCP works from curl but not LangGraph, the issue is almost always **`MCP_SERVERS_JSON`**, **`MCP_TOOL_ALLOWLIST`**, or **tool name prefix** mismatch.
