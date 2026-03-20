# Telegram meal photos: LangChain plans, myclaw pulls bytes

## End-to-end

1. **LangGraph `/goal tick` (LangSmith)** — **Initiates** processing: the planner emits explicit **`mcp.tool`** steps (`telegram_list_messages` as needed, then `weight_analyze_meal_photo` per photo). See [LANGGRAPH_TELEGRAM_PHOTOS.md](./LANGGRAPH_TELEGRAM_PHOTOS.md).
2. **Next.js orchestrator** — Can also plan similar tools for non–goal-tick flows when configured (`orchestrator/llm.ts`).
3. **`gym-telegram` MCP** — Used at execution time for `telegram_list_messages`, etc., to obtain **`fileId`**, `chatId`, `messageId` when the plan calls for it.
4. **`/api/agent/act` (myclaw)** — Executes returned `mcp.tool` actions. For **`gym-weight` + `weight_analyze_meal_photo`** when `telegram.fileId` is set:
   - Calls **Telegram Bot API** (`getFile` + file download) **directly from Next.js** with `MYCLAW_TELEGRAM_BOT_TOKEN`.
   - Sets **`imageBase64`** on the tool args and strips **`fileId`** from `telegram` (keeps `chatId` / `messageId` for D1).
5. **`gym-weight`** — Receives **bytes only** (`data:` / raw base64) for vision; does not need `TELEGRAM_BOT_TOKEN` for that path.

## Config

- **`MYCLAW_TELEGRAM_BOT_TOKEN`** — Same bot as `gym-telegram-mcp`. Required whenever analyzing Telegram photos via fileId.

## See also

- [LANGGRAPH_TELEGRAM_PHOTOS.md](./LANGGRAPH_TELEGRAM_PHOTOS.md) — LangSmith must initiate `mcp.tool` plans for `/goal tick`.
- [MCP_LOGGING.md](./MCP_LOGGING.md) — trace `telegram-hydrate` and `gym-weight` in logs.
