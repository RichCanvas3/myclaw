# Telegram meal photos: LangGraph plans, myclaw resolves URL, gym-weight fetches

## End-to-end

1. **LangGraph `/goal tick` (LangSmith)** — **Initiates** processing: the planner emits explicit **`mcp.tool`** steps (`telegram_list_messages` as needed, then `weight_analyze_meal_photo` per photo). See [LANGGRAPH_TELEGRAM_PHOTOS.md](./LANGGRAPH_TELEGRAM_PHOTOS.md).
2. **Next.js orchestrator** — Can also plan similar tools for non–goal-tick flows when configured (`orchestrator/llm.ts`).
3. **`gym-telegram` MCP** — Used at execution time for `telegram_list_messages`, etc., to obtain **`fileId`**, `chatId`, `messageId` when the plan calls for it.
4. **`/api/agent/act` (myclaw)** — Executes returned `mcp.tool` actions. For **`gym-weight` + `weight_analyze_meal_photo`** when `telegram.fileId` is set:
   - Calls **Telegram Bot API** `getFile` **only** (no file download on Next.js) with `MYCLAW_TELEGRAM_BOT_TOKEN` / `TELEGRAM_BOT_TOKEN`.
   - Sets **`imageUrl`** to `https://api.telegram.org/file/bot<TOKEN>/...` (secret: do not log or persist full URL).
   - Clears **`imageBase64`** and removes **`fileId`** from `telegram` in the JSON sent to gym-weight (keeps `chatId` / `messageId` for D1 columns).
5. **`gym-weight`** — Fetches **`imageUrl`** inside the worker, inlines to a `data:` URL, runs vision. If myclaw has **no** bot token, pass **`telegram.fileId`** through and set **`TELEGRAM_BOT_TOKEN`** on the worker instead (worker calls `getFile` + download).

## Config

- **`MYCLAW_TELEGRAM_BOT_TOKEN`** (recommended on myclaw) — Same bot as `gym-telegram-mcp`. Used to build Telegram file **URLs** after `getFile`.
- **`TELEGRAM_BOT_TOKEN`** on **weight worker** — Required when myclaw only forwards `telegram.fileId` (e.g. watch-goal without myclaw token).

## See also

- [LANGGRAPH_TELEGRAM_PHOTOS.md](./LANGGRAPH_TELEGRAM_PHOTOS.md) — LangSmith must initiate `mcp.tool` plans for `/goal tick`.
- [MCP_LOGGING.md](./MCP_LOGGING.md) — trace `telegram-hydrate` and `gym-weight` in logs.
