## myclaw memory worker (Cloudflare D1)

Durable memory + audit events for the myclaw orchestrator.

### Endpoints

All endpoints require:

- `Authorization: Bearer $MEMORY_API_KEY`

Routes:

- `GET /health`
- `GET /memory/get?churchId=...&userId=...&personId=...&householdId=...&namespace=...&key=...`
- `POST /memory/upsert` `{ scope, namespace, key, value, tags? }`
- `POST /memory/query` `{ scope, namespace?, q?, limit? }`
- `GET /memory/profile?churchId=...&userId=...&personId=...&householdId=...`
- `POST /events/append` `{ scope, type, payload }`

### Local notes

D1 bindings only work inside Workers. For local dev, use `wrangler dev` and point the Next.js app at it via `MEMORY_API_URL`.

