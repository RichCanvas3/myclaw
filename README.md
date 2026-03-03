# myclaw (monorepo)

## What’s inside

- `apps/myclaw`: Next.js (TypeScript) UI
- `apps/agent`: LangGraph graph for LangSmith Deployments (`apps.agent.graph:graph`)

## LangSmith Deployments (LangGraph)

This repo follows the same pattern as `churchcore`:

- `langgraph.json` points at `apps.agent.graph:graph`
- `requirements.txt` / `pyproject.toml` are intentionally minimal to avoid dependency constraint conflicts in hosted builds
- `pyproject.toml` makes `apps.*` importable

You deploy the **LangGraph** named `myclaw_agent`.

### Required env vars (deployment: myclaw agent)

- None required for network integrations (the graph is a director that emits action packs).

Optional:

- None

Optional (LangSmith tracing):

- `LANGSMITH_API_KEY`
- `LANGCHAIN_TRACING_V2=true`
- `LANGCHAIN_PROJECT=myclaw`

## Local dev

Install JS deps:

```bash
pnpm install
```

Run everything:

```bash
pnpm dev
```

Web runs on `http://localhost:3000` and calls your LangSmith Deployment via `LANGGRAPH_DEPLOYMENT_URL`.

### Web app env vars (Vercel / local)

Required:

- `LANGGRAPH_DEPLOYMENT_URL`
- `LANGGRAPH_API_KEY`
- `LANGGRAPH_ASSISTANT_ID=myclaw_agent`
- `CHURCHCORE_A2A_API_KEY`

Optional:

- `CHURCHCORE_A2A_BASE_URL` (defaults to Churchcore gateway)
- `MEMORY_API_URL` + `MEMORY_API_KEY` (for durable identity/household/BDI/goals memory)
- `GYM_MCP_API_KEY` + `GYM_WEATHER_MCP_URL` + `GYM_SENDGRID_MCP_URL` (for MCP tools like weather + email)

## Memory worker (Cloudflare D1)

This repo includes a minimal Cloudflare Worker + D1 schema at `apps/memory-worker`.

- D1 schema: `apps/memory-worker/schema.sql`
- Worker implementation: `apps/memory-worker/src/index.ts`

Run locally (in a separate terminal):

```bash
pnpm --filter @myclaw/memory-worker worker:dev
```

## Agent features (current)

- **Stored memory**: persisted in LangSmith thread state (use `/mem show` and `/mem set key=value`)
- **Indexed KB**: a simple per-thread index (use `/kb add <text>` and `/kb search <query>`)
- **Churchcore orchestration**: the agent returns `suggestedActions`; Next.js executes A2A calls server-side
  - Default action: `a2a.call` → `chat.stream`
  - Manual action: `/a2a <endpoint> [<json_payload>]` (example: `/a2a thread.list {"limit":20}`)
- **MCP tools (Next.js)**:
  - List tools: `/mcp-tools gym-weather` or `/mcp-tools gym-sendgrid`
  - Call tool: `/mcp gym-weather weather_current {"lat":40.0,"lon":-105.2,"units":"imperial"}`
  - Call tool: `/mcp gym-sendgrid sendEmail {"to":"you@example.com","subject":"Hi","text":"Hello"}`
  - Calendar tools: `/mcp-tools gym-googlecalendar` (then use orchestrated `calendar.range` actions)
