# myclaw (monorepo)

## What’s inside

- `apps/myclaw`: Next.js (TypeScript) UI
- `apps/agent`: LangGraph graph for LangSmith Deployments (`apps.agent.graph:graph`)

## LangSmith Deployments (LangGraph)

This repo follows the same pattern as `churchcore`:

- `langgraph.json` points at `apps.agent.graph:graph`
- `requirements.txt` contains Python deps for the deployment runtime
- `pyproject.toml` makes `apps.*` importable

You deploy the **LangGraph** named `myclaw_agent`.

### Required env vars (deployment)

- `DATABASE_URL` (remote Postgres, not localhost; usually `?sslmode=require`)
- `OPENAI_API_KEY` (or swap the LLM implementation)

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
