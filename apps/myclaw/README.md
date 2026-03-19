This is the `myclaw` Next.js web app (UI + server-side orchestrator).

## Telegram autonomous actions

If `gym-telegram-mcp` is configured, `myclaw` can **detect new Telegram messages and auto-act** server-side via:

- `POST /api/telegram/pump`: checks chats for new messages (cursor-based) and (optionally) runs the orchestrator to auto-reply using `telegram_send_message` only.
- `POST /api/telegram/watch-email`: keeps a stable `mcp-session-id`, subscribes to a chat resource, and sends an email when `telegram-mcp` delivers a `notifications/resources/updated` event (deduped by messageId).
- `POST /api/telegram/watch-goal`: keeps a stable `mcp-session-id`, subscribes to a chat resource, and forwards new chat messages into `/goal tick ...` (deduped by messageId). The goal runner can respond back into the same chat via `telegram_send_message`.

Environment variables (see `.env.example`):

- `GYM_TELEGRAM_MCP_URL`, `GYM_MCP_API_KEY`
- `MYCLAW_TELEGRAM_AUTOPOLL`, `MYCLAW_TELEGRAM_AUTOREPLY`
- `MYCLAW_TELEGRAM_BOT_USER_ID` (strongly recommended to avoid loops)
- `MYCLAW_TELEGRAM_NOTIFY_EMAIL_TO`, `MYCLAW_TELEGRAM_WATCH_CHAT_TITLE` (for watch-email)

Example:

```bash
curl -sS -X POST "http://localhost:3001/api/telegram/pump" \
  -H "content-type: application/json" \
  --data '{"subscribeTitles":["Smart Agent"]}'
```

Email-on-telegram tick:

```bash
curl -sS -X POST "http://localhost:3001/api/telegram/watch-email" \
  -H "content-type: application/json" \
  --data '{"chatTitle":"Smart Agent"}'
```

Goal-on-telegram tick:

```bash
curl -sS -X POST "http://localhost:3001/api/telegram/watch-goal" \
  -H "content-type: application/json" \
  --data '{"chatTitle":"Smart Agent"}'
```

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
