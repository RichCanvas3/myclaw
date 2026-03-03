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

- `CHURCHCORE_A2A_API_KEY` (send as `x-api-key` to the gateway)

Optional:

- `CHURCHCORE_A2A_BASE_URL` (defaults to `https://a2a-gateway-worker.richardpedersen3.workers.dev/a2a/`)

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

## Agent features (current)

- **Stored memory**: persisted in LangSmith thread state (use `/mem show` and `/mem set key=value`)
- **Indexed KB**: a simple per-thread index (use `/kb add <text>` and `/kb search <query>`)
- **Churchcore orchestration**: the agent returns `suggestedActions`; Next.js executes A2A calls server-side
  - Default action: `a2a.call` → `chat.stream`
  - Manual action: `/a2a <endpoint> [<json_payload>]` (example: `/a2a thread.list {"limit":20}`)
