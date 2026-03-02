# @myclaw/agent

## Setup

```bash
cd apps/agent
python3 -m venv .venv
.venv/bin/pip install -U pip
.venv/bin/pip install -r requirements.txt
cp .env.example .env
```

## Run

```bash
PYTHONPATH=src .venv/bin/python -m uvicorn myclaw_agent.server:app --reload --port 8000
```

Endpoints:

- `POST /agent/act` (SSE streaming)
- `POST /threads`
- `GET /threads/:id`
- `POST /kb/ingest`
