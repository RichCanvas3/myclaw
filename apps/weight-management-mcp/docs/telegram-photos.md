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

2. **myclaw (recommended):** set **`MYCLAW_TELEGRAM_BOT_TOKEN`** on Next.js (same bot as telegram-mcp). For `weight_analyze_meal_photo` calls that include **`telegram.fileId`** but no `imageBase64`/`imageUrl`, myclaw downloads the file via Bot API and passes **`imageBase64`** to the worker. The **weight worker does not need `TELEGRAM_BOT_TOKEN`** for that path.

3. **weight worker only:** set **`TELEGRAM_BOT_TOKEN`** on **weight-management-mcp** if clients send `telegram.fileId` **without** myclaw hydration. The worker then calls `getFile` and uses the HTTPS file URL for vision.

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
