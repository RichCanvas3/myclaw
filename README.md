# myclaw (monorepo)

## What’s inside

- `apps/myclaw`: Next.js (TypeScript) UI
- `apps/agent`: LangServe-based agent runtime (KB + memory + durable threads)

## Local dev

Start Postgres (pgvector):

```bash
docker compose up -d
```

Install JS deps:

```bash
pnpm install
```

Run everything:

```bash
pnpm dev
```

Agent runs on `http://localhost:8000`, web runs on `http://localhost:3000`.
