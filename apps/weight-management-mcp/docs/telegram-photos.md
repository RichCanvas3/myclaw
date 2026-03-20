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

2. **myclaw (recommended):** set **`MYCLAW_TELEGRAM_BOT_TOKEN`** on Next.js (same bot as telegram-mcp). When **`telegram.fileId`** is present, myclaw always downloads via Bot API and sends **raw `imageBase64`** to the worker (planner `imageUrl` is dropped). The weight worker inlines everything to a **`data:` URL** before the vision API — **no remote image URLs are sent to the model**.

3. **weight worker only:** set **`TELEGRAM_BOT_TOKEN`** on **weight-management-mcp** if clients send `telegram.fileId` **without** myclaw. The worker downloads the Telegram file, reads **bytes**, then calls vision with a **`data:`** payload only.

4. **Optional `imageUrl` (https):** supported only as a convenience: the worker **fetches once** and inlines bytes. Prefer **`imageBase64` + `telegram.fileId`**; do not treat image URLs as the primary integration.

Example args (fileId; myclaw will replace with base64 when token is set):

```json
{
  "scope": { ... },
  "telegram": { "fileId": "AgAC...", "chatId": "123", "messageId": 456 },
  "meal": "lunch"
}
```

5. Optional: pass **`telegram.botToken`** per request instead of env secrets (not recommended for production).

**Privacy:** analyses store `image_ref_json` (file id / URL hints), not raw image bytes in D1.
