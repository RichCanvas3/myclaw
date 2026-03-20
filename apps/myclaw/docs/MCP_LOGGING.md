# MCP + Telegram observability

## myclaw (Next.js)

Logs use the prefix **`[myclaw:<scope>]`** (`mcp`, `telegram-hydrate`, `watch-goal`, etc.).

| Env | Effect |
|-----|--------|
| `MYCLAW_DEBUG=1` | Force logging on (even in production). |
| `MYCLAW_DEBUG=0` | Force logging off. |
| `MYCLAW_MCP_LOG=1` / `0` | MCP-oriented alias for the same switch. |
| *(unset)* | Logs **on** when `NODE_ENV !== "production"`; **off** in production unless `MYCLAW_DEBUG=1`. |

**What’s logged**

- Every MCP request/response in `src/lib/mcp/client.ts` (server id, method, tool name, summarized args, duration). Image payloads are **not** dumped (lengths only).
- Telegram → base64 hydration in `src/lib/telegram/fetchFile.ts`.
- Watch-goal meal photo pipeline in `src/app/api/telegram/watch-goal/route.ts`.

View: local dev terminal, Vercel/hosting **Functions logs**, or Docker logs.

## weight-management-mcp (Worker)

| Env / var | Effect |
|-----------|--------|
| `WEIGHT_MCP_LOG` wrangler `[vars]` or dashboard | Default **`1`** in `wrangler.toml`. Set **`0`** / **`false`** to silence. |

**What’s logged**

- `[weight-mcp] http_enter` — `/mcp` hit.
- `[weight-mcp] jsonrpc` / `tools/call` — tool name + summarized args (no raw base64).
- `[weight-mcp] tools/call_ok` — duration ms.
- Errors via `jsonrpc_error`.

View: **Wrangler** `wrangler tail`, or Workers **Logs** in the Cloudflare dashboard.

## gym-telegram-mcp (separate repo / worker)

This monorepo only points at **`GYM_TELEGRAM_MCP_URL`**; the Telegram worker source may live elsewhere.

1. **Tail live logs:** `wrangler tail <your-telegram-worker-name>`
2. **Add request logging** in that worker’s MCP handler (see [`docs/snippets/telegram-mcp-logging.example.ts`](./snippets/telegram-mcp-logging.example.ts) for a drop-in pattern).
