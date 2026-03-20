# LangGraph / LangSmith: initiating Telegram meal-photo processing

## Who starts the work?

| Layer | Role |
|-------|------|
| **LangGraph** (`/goal tick` → `_goal_tick_action_pack`) | **Primary.** The OpenAI planner on the LangSmith deployment returns JSON with `actions` that MUST include real `mcp.tool` calls: `gym-telegram` (e.g. `telegram_list_messages`) and `gym-weight` (`weight_analyze_meal_photo` with `telegram.fileId`, `chatId`, `messageId`). |
| **myclaw `/api/agent/act`** | **Executes** those actions. For `weight_analyze_meal_photo`, it calls Telegram `getFile` (metadata only), sets **`imageUrl`** for gym-weight, and does **not** download image bytes on Next.js. |
| **myclaw inject + queue** (`injectMealPhotoActions.ts`) | **Safety net** if the planner forgets gym-weight; does not replace LangGraph initiation. |

## LangSmith deployment checklist

1. **`MCP_SERVERS_JSON`** includes `gym-telegram` and `gym-weight` (same URLs/keys as myclaw).
2. **`MCP_TOOL_ALLOWLIST`** includes `telegram_list_messages`, `weight_analyze_meal_photo`, etc. ([MCP_TOOL_ALLOWLIST.md](./MCP_TOOL_ALLOWLIST.md)).
3. **Redeploy the graph** after changing `apps/agent/graph.py` so the system prompt matches this repo.

## User / product flow

- Users should drive meal-photo work through **`/goal tick …`** (with a hint) so the goal-tick planner runs with `[context]` (calendar + telegram snippet from myclaw).
- General chat without `/goal tick` goes through a different graph branch (A2A) and does **not** use this planner.

## See also

- [TELEGRAM_PHOTO_FLOW.md](./TELEGRAM_PHOTO_FLOW.md) — URL path (worker fetch).
