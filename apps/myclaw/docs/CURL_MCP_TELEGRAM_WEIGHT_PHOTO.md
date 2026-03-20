# Curl: MCP tool calls (same shape as LangChain / LangSmith)

Two **JSON-RPC** `tools/call` requests over HTTP — same `method`, `params.name`, `params.arguments` your hosted agent sends to **gym-telegram** and **gym-weight**.

Headers (match `apps/myclaw/src/lib/mcp/client.ts`):

- `content-type: application/json`
- `accept: application/json, text/event-stream`
- `x-api-key: <GYM_MCP_API_KEY>`

Responses are **SSE**: one `data: { "jsonrpc":"2.0", ... }` line; tool output is in `result.content[0].text` (stringified JSON).

## Prereqs

- `GYM_TELEGRAM_MCP_URL`, `GYM_WEIGHT_MCP_URL`, `GYM_MCP_API_KEY`
- **`TELEGRAM_BOT_TOKEN`** on **weight-management-mcp** (Worker secret) when using `telegram.fileId` (no `imageUrl`)
- **`/telegram/media/...`** on gym-telegram-mcp is a **public GET** (no `x-api-key`). Gym-weight fetches it like plain `curl`.
- **`VISION_API_KEY`** on weight worker for vision
- `jq` installed for the chained example

## 1) `telegram_list_messages` — “Smart Agent”

```bash
export GYM_TELEGRAM_MCP_URL="https://your-telegram-worker/mcp"
export GYM_MCP_API_KEY="your-key"

curl -sS -X POST "$GYM_TELEGRAM_MCP_URL" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -H "x-api-key: $GYM_MCP_API_KEY" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "telegram_list_messages",
      "arguments": {
        "chatTitle": "Smart Agent",
        "limit": 20
      }
    }
  }'
```

## 2) `weight_analyze_meal_photo` — same RPC shape as the LLM

Fill `scope`, `chatId`, `messageId`, `fileId` from step 1’s inner JSON (`chatId`, `messages[].messageId`, largest photo’s `fileId`).

```bash
export GYM_WEIGHT_MCP_URL="https://your-weight-worker/mcp"

curl -sS -X POST "$GYM_WEIGHT_MCP_URL" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -H "x-api-key: $GYM_MCP_API_KEY" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "weight_analyze_meal_photo",
      "arguments": {
        "scope": {
          "churchId": "calvarybible",
          "userId": "demo_user_noah",
          "personId": "p_seeker_2"
        },
        "meal": "Meal from Smart Agent (curl)",
        "telegram": {
          "fileId": "PASTE_TELEGRAM_FILE_ID",
          "chatId": "PASTE_CHAT_ID",
          "messageId": 12345
        }
      }
    }
  }'
```

## One-shot: list → first photo → analyze

```bash
set -euo pipefail
export GYM_TELEGRAM_MCP_URL="${GYM_TELEGRAM_MCP_URL:?}"
export GYM_WEIGHT_MCP_URL="${GYM_WEIGHT_MCP_URL:?}"
export GYM_MCP_API_KEY="${GYM_MCP_API_KEY:?}"

mcp_sse_body() {
  local url="$1" json="$2"
  LANG=C curl -sS -X POST "$url" \
    -H "content-type: application/json" \
    -H "accept: application/json, text/event-stream" \
    -H "x-api-key: $GYM_MCP_API_KEY" \
    -d "$json"
}

rpc_data() { grep '^data: ' | sed 's/^data: //' | head -1; }

LIST_RPC=$(mcp_sse_body "$GYM_TELEGRAM_MCP_URL" '{
  "jsonrpc":"2.0","id":1,"method":"tools/call",
  "params":{"name":"telegram_list_messages","arguments":{"chatTitle":"Smart Agent","limit":25}}
}' | rpc_data)

INNER=$(echo "$LIST_RPC" | jq -r '.result.content[0].text // empty' | jq .)
CHAT_ID=$(echo "$INNER" | jq -r '.chatId // empty')
ROW=$(echo "$INNER" | jq '[.messages[]? | select(
  ((.photos   | type) == "array" and (.photos | length) > 0) or
  ((.photo    | type) == "array" and (.photo  | length) > 0)
)][0]')
if [ "$(echo "$ROW" | jq -r 'type')" != "object" ]; then
  echo "No photo messages in list." >&2
  echo "$INNER" | jq . >&2
  exit 1
fi
MSG_ID=$(echo "$ROW" | jq -r '.messageId // empty')
FILE_ID=$(echo "$ROW" | jq -r 'if ((.photos // []) | length) > 0 then .photos[-1].fileId // .photos[-1].file_id else .photo[-1].fileId // .photo[-1].file_id end')
if [ -z "$FILE_ID" ] || [ -z "$MSG_ID" ]; then
  echo "Could not read messageId/fileId from first photo row." >&2
  exit 1
fi

WT_ARGS=$(jq -n \
  --arg chatId "$CHAT_ID" \
  --arg fileId "$FILE_ID" \
  --argjson messageId "$MSG_ID" \
  --arg churchId "${CHURCH_ID:-calvarybible}" \
  --arg userId "${USER_ID:-demo_user_noah}" \
  --arg personId "${PERSON_ID:-p_seeker_2}" \
  '{
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "weight_analyze_meal_photo",
      arguments: {
        scope: { churchId: $churchId, userId: $userId, personId: $personId },
        meal: "Smart Agent photo (curl chain)",
        telegram: { fileId: $fileId, chatId: $chatId, messageId: $messageId }
      }
    }
  }')

echo "Calling weight_analyze_meal_photo chatId=$CHAT_ID messageId=$MSG_ID" >&2
mcp_sse_body "$GYM_WEIGHT_MCP_URL" "$WT_ARGS" | rpc_data | jq .
```

## Logs on weight worker

With `WEIGHT_MCP_LOG` unset or `1`, after a successful analysis you should see:

```text
[weight-mcp] meal_photo/processed {"analysisId":"...","summary":"...","image_https_url":"https://api.telegram.org/file/bot...","image_source":"https_fetch"}
```

`image_https_url` is **null** when the tool was called with only `imageBase64`.

Tail logs:

```bash
cd apps/weight-management-mcp && pnpm exec wrangler tail
```
