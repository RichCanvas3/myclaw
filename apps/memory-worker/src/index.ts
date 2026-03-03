export interface Env {
  DB: D1Database;
  MEMORY_API_KEY?: string;
}

type Scope = {
  churchId?: string;
  userId?: string;
  personId?: string;
  householdId?: string | null;
};

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {}),
    },
  });
}

function ok(): Response {
  return json({ ok: true });
}

function nowMs(): number {
  return Date.now();
}

function scopeId(scope: Scope): string {
  return [
    scope.churchId ?? "",
    scope.userId ?? "",
    scope.personId ?? "",
    scope.householdId ?? "",
  ].join(":");
}

function requireAuth(req: Request, env: Env): void {
  const expected = env.MEMORY_API_KEY ?? "";
  if (!expected) throw new Error("Server misconfigured: MEMORY_API_KEY missing");

  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  if (!token || token !== expected) throw new Response("Unauthorized", { status: 401 });
}

async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (!text) return {};
  return JSON.parse(text) as unknown;
}

function cors(req: Request): HeadersInit {
  const origin = req.headers.get("origin") ?? "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    "access-control-max-age": "86400",
  };
}

async function handleOptions(req: Request): Promise<Response> {
  return new Response(null, { status: 204, headers: cors(req) });
}

async function handleHealth(req: Request): Promise<Response> {
  return json({ ok: true, ts: nowMs() }, { headers: cors(req) });
}

async function handleUpsert(req: Request, env: Env): Promise<Response> {
  requireAuth(req, env);
  const body = await readJson(req);
  if (typeof body !== "object" || body === null) return json({ error: "invalid_json" }, { status: 400 });

  const b = body as Record<string, unknown>;
  const namespace = typeof b.namespace === "string" ? b.namespace : null;
  const key = typeof b.key === "string" ? b.key : null;
  const scope = (typeof b.scope === "object" && b.scope !== null ? (b.scope as Record<string, unknown>) : {}) as Record<
    string,
    unknown
  >;
  const value = b.value;
  const tags = Array.isArray(b.tags) ? b.tags : [];

  const scopeObj: Scope = {
    churchId: typeof scope.churchId === "string" ? scope.churchId : undefined,
    userId: typeof scope.userId === "string" ? scope.userId : undefined,
    personId: typeof scope.personId === "string" ? scope.personId : undefined,
    householdId: typeof scope.householdId === "string" ? scope.householdId : null,
  };

  if (!namespace || !key) return json({ error: "missing_namespace_or_key" }, { status: 400, headers: cors(req) });

  const sid = scopeId(scopeObj);
  const id = crypto.randomUUID();
  const ts = nowMs();

  await env.DB.prepare(
    `INSERT INTO mem_records (id, scope_id, scope_json, namespace, key, value_json, tags_json, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(scope_id, namespace, key)
     DO UPDATE SET value_json=excluded.value_json, tags_json=excluded.tags_json, updated_at=excluded.updated_at`
  )
    .bind(
      id,
      sid,
      JSON.stringify(scopeObj),
      namespace,
      key,
      JSON.stringify(value ?? null),
      JSON.stringify(tags),
      ts
    )
    .run();

  return json({ ok: true, scope_id: sid, namespace, key, updated_at: ts }, { headers: cors(req) });
}

async function handleQuery(req: Request, env: Env): Promise<Response> {
  requireAuth(req, env);
  const body = await readJson(req);
  if (typeof body !== "object" || body === null) return json({ error: "invalid_json" }, { status: 400, headers: cors(req) });

  const b = body as Record<string, unknown>;
  const namespace = typeof b.namespace === "string" ? b.namespace : null;
  const q = typeof b.q === "string" ? b.q : null;
  const limit = typeof b.limit === "number" && b.limit > 0 ? Math.min(b.limit, 200) : 50;

  const scope = (typeof b.scope === "object" && b.scope !== null ? (b.scope as Record<string, unknown>) : {}) as Record<
    string,
    unknown
  >;
  const scopeObj: Scope = {
    churchId: typeof scope.churchId === "string" ? scope.churchId : undefined,
    userId: typeof scope.userId === "string" ? scope.userId : undefined,
    personId: typeof scope.personId === "string" ? scope.personId : undefined,
    householdId: typeof scope.householdId === "string" ? scope.householdId : null,
  };
  const sid = scopeId(scopeObj);

  const where: string[] = ["scope_id = ?1"];
  const binds: unknown[] = [sid];
  if (namespace) {
    where.push("namespace = ?2");
    binds.push(namespace);
  }
  if (q) {
    where.push("value_json LIKE ?3");
    binds.push(`%${q}%`);
  }

  const sql = `SELECT namespace, key, value_json, tags_json, updated_at
               FROM mem_records
               WHERE ${where.join(" AND ")}
               ORDER BY updated_at DESC
               LIMIT ${limit}`;

  const stmt = env.DB.prepare(sql);
  const res = await stmt.bind(...binds).all();
  const items = (res.results ?? []).map((r) => ({
    namespace: r.namespace,
    key: r.key,
    value: safeJson(r.value_json),
    tags: safeJson(r.tags_json) ?? [],
    updated_at: r.updated_at,
  }));
  return json({ ok: true, scope_id: sid, items }, { headers: cors(req) });
}

async function handleProfile(req: Request, env: Env): Promise<Response> {
  requireAuth(req, env);
  const url = new URL(req.url);
  const scopeObj: Scope = {
    churchId: url.searchParams.get("churchId") ?? undefined,
    userId: url.searchParams.get("userId") ?? undefined,
    personId: url.searchParams.get("personId") ?? undefined,
    householdId: url.searchParams.get("householdId"),
  };
  const sid = scopeId(scopeObj);

  const res = await env.DB.prepare(
    `SELECT namespace, key, value_json, tags_json, updated_at
     FROM mem_records
     WHERE scope_id = ?1
     ORDER BY updated_at DESC
     LIMIT 500`
  )
    .bind(sid)
    .all();

  const grouped: Record<string, Record<string, unknown>> = {};
  for (const r of res.results ?? []) {
    const ns = String(r.namespace);
    const k = String(r.key);
    grouped[ns] ??= {};
    grouped[ns][k] = safeJson(String(r.value_json));
  }

  return json({ ok: true, scope_id: sid, scope: scopeObj, profile: grouped }, { headers: cors(req) });
}

async function handleGet(req: Request, env: Env): Promise<Response> {
  requireAuth(req, env);
  const url = new URL(req.url);
  const namespace = url.searchParams.get("namespace");
  const key = url.searchParams.get("key");
  if (!namespace || !key) return json({ error: "missing_namespace_or_key" }, { status: 400, headers: cors(req) });

  const scopeObj: Scope = {
    churchId: url.searchParams.get("churchId") ?? undefined,
    userId: url.searchParams.get("userId") ?? undefined,
    personId: url.searchParams.get("personId") ?? undefined,
    householdId: url.searchParams.get("householdId"),
  };
  const sid = scopeId(scopeObj);

  const res = await env.DB.prepare(
    `SELECT namespace, key, value_json, tags_json, updated_at
     FROM mem_records
     WHERE scope_id = ?1 AND namespace = ?2 AND key = ?3
     LIMIT 1`
  )
    .bind(sid, namespace, key)
    .all();

  const row = (res.results ?? [])[0] as
    | { namespace?: unknown; key?: unknown; value_json?: unknown; tags_json?: unknown; updated_at?: unknown }
    | undefined;
  if (!row) return json({ ok: false, error: "not_found" }, { status: 404, headers: cors(req) });

  return json(
    {
      ok: true,
      scope_id: sid,
      namespace: String(row.namespace),
      key: String(row.key),
      value: safeJson(String(row.value_json)),
      tags: safeJson(String(row.tags_json)) ?? [],
      updated_at: row.updated_at,
    },
    { headers: cors(req) }
  );
}

async function handleEventAppend(req: Request, env: Env): Promise<Response> {
  requireAuth(req, env);
  const body = await readJson(req);
  if (typeof body !== "object" || body === null) return json({ error: "invalid_json" }, { status: 400, headers: cors(req) });

  const b = body as Record<string, unknown>;
  const type = typeof b.type === "string" ? b.type : null;
  const payload = b.payload ?? null;
  const scope = (typeof b.scope === "object" && b.scope !== null ? (b.scope as Record<string, unknown>) : {}) as Record<
    string,
    unknown
  >;
  const scopeObj: Scope = {
    churchId: typeof scope.churchId === "string" ? scope.churchId : undefined,
    userId: typeof scope.userId === "string" ? scope.userId : undefined,
    personId: typeof scope.personId === "string" ? scope.personId : undefined,
    householdId: typeof scope.householdId === "string" ? scope.householdId : null,
  };
  if (!type) return json({ error: "missing_type" }, { status: 400, headers: cors(req) });

  const sid = scopeId(scopeObj);
  const id = crypto.randomUUID();
  const ts = nowMs();

  await env.DB.prepare(
    `INSERT INTO mem_events (id, scope_id, scope_json, type, payload_json, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  )
    .bind(id, sid, JSON.stringify(scopeObj), type, JSON.stringify(payload), ts)
    .run();

  return json({ ok: true, id, created_at: ts }, { headers: cors(req) });
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return s;
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return handleOptions(req);

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "");

    try {
      if (path === "" || path === "/") return json({ ok: true, service: "myclaw-memory" }, { headers: cors(req) });
      if (path === "/health") return handleHealth(req);

      if (req.method === "POST" && path === "/memory/upsert") return await handleUpsert(req, env);
      if (req.method === "POST" && path === "/memory/query") return await handleQuery(req, env);
      if (req.method === "GET" && path === "/memory/profile") return await handleProfile(req, env);
      if (req.method === "GET" && path === "/memory/get") return await handleGet(req, env);
      if (req.method === "POST" && path === "/events/append") return await handleEventAppend(req, env);

      return new Response("Not found", { status: 404, headers: cors(req) });
    } catch (e) {
      if (e instanceof Response) return e;
      const msg = e instanceof Error ? e.message : String(e);
      return json({ error: msg }, { status: 500, headers: cors(req) });
    }
  },
};

