import type { OrchestratorContext } from "@/lib/agents/types";
import path from "node:path";
import { promises as fs } from "node:fs";

function memoryApiUrl(): string | null {
  const v = (process.env.MEMORY_API_URL ?? "").trim();
  return v ? v : null;
}

function memoryApiKey(): string | null {
  const v = (process.env.MEMORY_API_KEY ?? "").trim();
  return v ? v : null;
}

function scopeFromContext(ctx: OrchestratorContext): Record<string, unknown> {
  return {
    churchId: ctx.churchId,
    userId: ctx.userId,
    personId: ctx.personId,
    householdId: ctx.householdId ?? null,
  };
}

function scopeIdFromContext(ctx: OrchestratorContext): string {
  return [ctx.churchId ?? "", ctx.userId ?? "", ctx.personId ?? "", ctx.householdId ?? ""].join(":");
}

type LocalRecord = { value: unknown; tags: unknown[]; updated_at: number };
type LocalStore = {
  records: Record<string, Record<string, Record<string, LocalRecord>>>;
  events: Record<string, Array<{ type: string; payload: unknown; ts: number }>>;
};

function localStorePath(): string {
  const configured = (process.env.MYCLAW_MEMORY_FILE_PATH ?? "").trim();
  if (configured) return configured;
  return path.join(process.cwd(), ".myclaw", "memory.json");
}

function withLocalLock<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as unknown as { __myclawMemoryLock?: Promise<void> };
  const prev = g.__myclawMemoryLock ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => (release = r));
  g.__myclawMemoryLock = prev.then(() => next);
  return prev
    .then(fn)
    .finally(() => {
      release();
    });
}

async function loadLocalStore(): Promise<LocalStore> {
  const p = localStorePath();
  try {
    const raw = await fs.readFile(p, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const rec = parsed as Partial<LocalStore>;
      return {
        records: (rec.records as LocalStore["records"]) ?? {},
        events: (rec.events as LocalStore["events"]) ?? {},
      };
    }
  } catch {
    // ignore
  }
  return { records: {}, events: {} };
}

async function saveLocalStore(store: LocalStore): Promise<void> {
  const p = localStorePath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(store, null, 2), "utf-8");
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
  if (!url || !key) {
    return withLocalLock(async () => {
      const store = await loadLocalStore();
      const sid = scopeIdFromContext(ctx);
      const scopeRecords = store.records[sid] ?? {};
      const profile: Record<string, Record<string, unknown>> = {};
      // Roughly match memory-worker profile shape: { ok, scope_id, scope, profile }
      for (const [ns, kv] of Object.entries(scopeRecords)) {
        profile[ns] = {};
        for (const [k2, rec] of Object.entries(kv)) {
          profile[ns]![k2] = rec.value;
        }
      }
      return { ok: true, scope_id: sid, scope: scopeFromContext(ctx), profile };
    });
  }

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
  if (!url || !keyEnv) {
    return withLocalLock(async () => {
      const store = await loadLocalStore();
      const sid = scopeIdFromContext(params.ctx);
      const rec = store.records?.[sid]?.[params.namespace]?.[params.key];
      if (!rec) return null;
      return {
        ok: true,
        scope_id: sid,
        namespace: params.namespace,
        key: params.key,
        value: rec.value,
        tags: rec.tags ?? [],
        updated_at: rec.updated_at,
      };
    });
  }

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
  const url = memoryApiUrl();
  const keyEnv = memoryApiKey();
  if (!url || !keyEnv) {
    return withLocalLock(async () => {
      const store = await loadLocalStore();
      const sid = scopeIdFromContext(params.ctx);
      store.records[sid] ??= {};
      store.records[sid]![params.namespace] ??= {};
      const ts = Date.now();
      store.records[sid]![params.namespace]![params.key] = {
        value: params.value ?? null,
        tags: params.tags ?? [],
        updated_at: ts,
      };
      await saveLocalStore(store);
      return { ok: true, scope_id: sid, namespace: params.namespace, key: params.key, updated_at: ts };
    });
  }

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
  const url = memoryApiUrl();
  const keyEnv = memoryApiKey();
  if (!url || !keyEnv) {
    return withLocalLock(async () => {
      const store = await loadLocalStore();
      const sid = scopeIdFromContext(params.ctx);
      const scopeRecords = store.records[sid] ?? {};
      const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
      const q = (params.q ?? "").trim();
      const out: Array<{ namespace: string; key: string; value: unknown; tags: unknown[]; updated_at: number }> = [];
      for (const [ns, kv] of Object.entries(scopeRecords)) {
        if (params.namespace && ns !== params.namespace) continue;
        for (const [k2, rec] of Object.entries(kv)) {
          if (q) {
            const hay = JSON.stringify(rec.value ?? null);
            if (!hay.includes(q)) continue;
          }
          out.push({ namespace: ns, key: k2, value: rec.value, tags: rec.tags ?? [], updated_at: rec.updated_at });
        }
      }
      out.sort((a, b) => b.updated_at - a.updated_at);
      return { ok: true, scope_id: sid, items: out.slice(0, limit) };
    });
  }

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
  if (!url || !key) {
    await withLocalLock(async () => {
      const store = await loadLocalStore();
      const sid = scopeIdFromContext(params.ctx);
      store.events[sid] ??= [];
      store.events[sid]!.push({ type: params.type, payload: params.payload ?? null, ts: Date.now() });
      // keep bounded
      if (store.events[sid]!.length > 2000) store.events[sid] = store.events[sid]!.slice(-2000);
      await saveLocalStore(store);
    });
    return;
  }

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

