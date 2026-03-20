# Telegram meal photos → weight-mcp

End-to-end flow:

1. **telegram-mcp** (or any poller) should persist each message with **`photos[]`** on the JSON you pass into `weight_ingest_telegram_message`:

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

2. **weight-management-mcp** worker must have **`TELEGRAM_BOT_TOKEN`** set (same bot that received the file). The tool `weight_analyze_meal_photo` can then accept:

```json
{
  "scope": { ... },
  "telegram": { "fileId": "AgAC...", "chatId": "123", "messageId": 456 },
  "meal": "lunch"
}
```

The worker calls `getFile` and builds `https://api.telegram.org/file/bot<token>/<file_path>` for the vision API.

3. Optional: pass **`telegram.botToken`** per request instead of the worker secret (not recommended for production).

**Privacy:** analyses store `image_ref_json` (file id / URL hints), not raw image bytes in D1.
