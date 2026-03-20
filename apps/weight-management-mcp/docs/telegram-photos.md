# Telegram meal photos → weight-mcp

End-to-end flow:

1. **telegram-mcp** must expose **`file_id` / `fileId`** on photo messages returned by **`telegram_list_messages`** (and in payloads to `weight_ingest_telegram_message`). Without that, myclaw cannot call `weight_analyze_meal_photo` with `telegram.fileId`. Persist each message with **`photos[]`** when using ingest:

```json
{
  "scope": { "churchId": "...", "userId": "...", "personId": "..." },
  "chatId": "123",
  "messageId": 456,
  "text": "lunch",
  "caption": "optional",
  "photos": [
    {
      "fileId": "AgAC...",
      "fileUniqueId": "optional",
      "width": 1280,
      "height": 720
    }
  ]
}
```

Each object must include **`fileId`** (Telegram `photo` sizes / `file_id`).

2. **myclaw (recommended):** set **`MYCLAW_TELEGRAM_BOT_TOKEN`** on Next.js (same bot as telegram-mcp). When **`telegram.fileId`** is present, myclaw calls **`getFile`** only (no download on Next.js), builds `https://api.telegram.org/file/bot<TOKEN>/...`, sets **`imageUrl`** on `weight_analyze_meal_photo`, and strips **`fileId`** from `telegram` before the MCP call (keeps `chatId` / `messageId`). **That URL embeds the bot token** — do not log it or store it in D1; gym-weight only uses it in memory to fetch bytes.

3. **weight worker only (no myclaw token):** set **`TELEGRAM_BOT_TOKEN`** on **weight-management-mcp**. Clients can send **`telegram.fileId`** (and optional `chatId` / `messageId`); the worker calls `getFile`, downloads the file, inlines to **`data:`**, runs vision.

4. **`imageUrl` (https)** is the **preferred** path from myclaw (Telegram file URL). Other https URLs are supported the same way (worker fetches once). Legacy **`imageBase64`** still works for small payloads.

Example args (fileId; myclaw will replace with `imageUrl` when token is set):

```json
{
  "scope": { ... },
  "telegram": { "fileId": "AgAC...", "chatId": "123", "messageId": 456 },
  "meal": "lunch"
}
```

5. Optional: pass **`telegram.botToken`** per request instead of env secrets (not recommended for production).

**Privacy:** analyses store `image_ref_json` (source hints, optional `fileId`, never the full token-bearing URL), not raw image bytes in D1.
