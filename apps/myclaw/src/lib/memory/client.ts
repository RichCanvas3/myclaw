import type { OrchestratorContext } from "@/lib/agents/types";

function memoryApiUrl(): string | null {
  return process.env.MEMORY_API_URL ?? null;
}

function memoryApiKey(): string | null {
  return process.env.MEMORY_API_KEY ?? null;
}

function scopeFromContext(ctx: OrchestratorContext): Record<string, unknown> {
  return {
    churchId: ctx.churchId,
    userId: ctx.userId,
    personId: ctx.personId,
    householdId: ctx.householdId ?? null,
  };
}

async function memoryFetch(path: string, init: RequestInit): Promise<Response> {
  const url = memoryApiUrl();
  const key = memoryApiKey();
  if (!url || !key) throw new Error("Memory service not configured (MEMORY_API_URL/MEMORY_API_KEY)");

  const full = url.replace(/\/+$/, "") + path;
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${key}`);
  return fetch(full, { ...init, headers });
}

export async function memoryGetProfile(ctx: OrchestratorContext): Promise<unknown> {
  const url = memoryApiUrl();
  const key = memoryApiKey();
  if (!url || !key) return null;

  const qs = new URLSearchParams({
    churchId: ctx.churchId,
    userId: ctx.userId,
    personId: ctx.personId,
  });
  if (ctx.householdId) qs.set("householdId", ctx.householdId);

  const res = await memoryFetch(`/memory/profile?${qs.toString()}`, { method: "GET" });
  if (!res.ok) throw new Error(`memory profile error: ${res.status} - ${await res.text()}`);
  return (await res.json()) as unknown;
}

export async function memoryGet(params: {
  ctx: OrchestratorContext;
  namespace: string;
  key: string;
}): Promise<unknown | null> {
  const url = memoryApiUrl();
  const keyEnv = memoryApiKey();
  if (!url || !keyEnv) return null;

  const qs = new URLSearchParams({
    churchId: params.ctx.churchId,
    userId: params.ctx.userId,
    personId: params.ctx.personId,
    namespace: params.namespace,
    key: params.key,
  });
  if (params.ctx.householdId) qs.set("householdId", params.ctx.householdId);

  const res = await memoryFetch(`/memory/get?${qs.toString()}`, { method: "GET" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`memory get error: ${res.status} - ${await res.text()}`);
  return (await res.json()) as unknown;
}

export async function memoryUpsert(params: {
  ctx: OrchestratorContext;
  namespace: string;
  key: string;
  value: unknown;
  tags?: unknown[];
}): Promise<unknown> {
  const res = await memoryFetch("/memory/upsert", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scope: scopeFromContext(params.ctx),
      namespace: params.namespace,
      key: params.key,
      value: params.value,
      tags: params.tags ?? [],
    }),
  });
  if (!res.ok) throw new Error(`memory upsert error: ${res.status} - ${await res.text()}`);
  return (await res.json()) as unknown;
}

export async function memoryQuery(params: {
  ctx: OrchestratorContext;
  namespace?: string;
  q?: string;
  limit?: number;
}): Promise<unknown> {
  const res = await memoryFetch("/memory/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scope: scopeFromContext(params.ctx),
      namespace: params.namespace ?? null,
      q: params.q ?? null,
      limit: params.limit ?? 50,
    }),
  });
  if (!res.ok) throw new Error(`memory query error: ${res.status} - ${await res.text()}`);
  return (await res.json()) as unknown;
}

export async function memoryAppendEvent(params: {
  ctx: OrchestratorContext;
  type: string;
  payload: unknown;
}): Promise<void> {
  const url = memoryApiUrl();
  const key = memoryApiKey();
  if (!url || !key) return;

  const res = await memoryFetch("/events/append", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scope: scopeFromContext(params.ctx),
      type: params.type,
      payload: params.payload,
    }),
  });
  if (!res.ok) throw new Error(`memory append error: ${res.status} - ${await res.text()}`);
}

