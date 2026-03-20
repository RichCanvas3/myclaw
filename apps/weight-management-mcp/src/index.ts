export interface Env {
  DB: D1Database;
  MCP_API_KEY?: string;
  /** OpenAI-compatible vision (e.g. gpt-4o-mini). */
  VISION_API_KEY?: string;
  VISION_MODEL?: string;
  VISION_OPENAI_BASE_URL?: string;
  /** For `telegram.fileId` image resolution (getFile → file URL). */
  TELEGRAM_BOT_TOKEN?: string;
  /** Set to "0" / "false" to silence `[weight-mcp]` console logs. */
  WEIGHT_MCP_LOG?: string;
}

type Scope = {
  churchId?: string;
  userId?: string;
  personId?: string;
  householdId?: string | null;
  // Optional stable app-level identity key.
  accountAddress?: string;
};

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
};

function sseJson(data: unknown): string {
  return `event: message\ndata: ${JSON.stringify(data)}\n\n`;
}

function okResult(id: number | string, text: string, extra?: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text }],
      ...(extra ?? {}),
    },
  };
}

function errResult(id: number | string, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {}),
    },
  });
}

function cors(req: Request): HeadersInit {
  const origin = req.headers.get("origin") ?? "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-api-key",
    "access-control-max-age": "86400",
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function requireAuth(req: Request, env: Env) {
  const expected = (env.MCP_API_KEY ?? "").trim();
  if (!expected) throw new Error("Server misconfigured: MCP_API_KEY missing");
  const got = (req.headers.get("x-api-key") ?? "").trim();
  if (!got || got !== expected) throw new Response("Unauthorized", { status: 401 });
}

function weightMcpLogEnabled(env: Env): boolean {
  const v = (env.WEIGHT_MCP_LOG ?? "").trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  return true;
}

function weightMcpLog(env: Env, event: string, detail?: Record<string, unknown>): void {
  if (!weightMcpLogEnabled(env)) return;
  const extra = detail && Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : "";
  console.log(`[weight-mcp] ${event}${extra}`);
}

/** Safe args summary for logs (no raw base64). */
function summarizeWeightToolArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const sc = isRecord(args.scope) ? args.scope : null;
  const scopeHint = sc
    ? {
        churchId: typeof sc.churchId === "string" ? sc.churchId : undefined,
        userId: typeof sc.userId === "string" ? sc.userId : undefined,
        personId: typeof sc.personId === "string" ? sc.personId : undefined,
      }
    : {};

  if (name === "weight_analyze_meal_photo") {
    const tg = isRecord(args.telegram) ? args.telegram : null;
    const b64len = typeof args.imageBase64 === "string" ? args.imageBase64.length : 0;
    return {
      ...scopeHint,
      imageBase64_chars: b64len,
      has_imageUrl: Boolean(normStr(args.imageUrl)),
      telegram_fileId: tg && typeof tg.fileId === "string" ? `${String(tg.fileId).slice(0, 14)}…` : undefined,
      telegram_chatId: tg && typeof tg.chatId === "string" ? tg.chatId : undefined,
      telegram_messageId: tg && typeof tg.messageId === "number" ? tg.messageId : undefined,
    };
  }

  if (name === "weight_log_food_from_analysis") {
    const aid = normStr(args.analysisId);
    return {
      ...scopeHint,
      analysisId_prefix: aid ? `${aid.slice(0, 8)}…` : "",
      mode: args.mode,
    };
  }

  const keys = Object.keys(args).filter((k) => k !== "scope");
  return { ...scopeHint, argKeys: keys.slice(0, 14) };
}

function nowMs(): number {
  return Date.now();
}

function scopeId(scope: Scope): string {
  if (scope.accountAddress) return `acct:${scope.accountAddress}`;
  return [scope.churchId ?? "", scope.userId ?? "", scope.personId ?? "", scope.householdId ?? ""].join(":");
}

function normStr(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}

const MAX_MEAL_IMAGE_BYTES = 8 * 1024 * 1024;

/** Optional https image reference — fetched server-side and converted to bytes (never passed to vision as http). */
function isFetchableHttpsImageUrl(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  try {
    const u = new URL(t);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

async function fetchHttpUrlAsDataUrl(url: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch image HTTP ${r.status}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.length > MAX_MEAL_IMAGE_BYTES) {
    throw new Error(`image too large (${buf.length} bytes; max ${MAX_MEAL_IMAGE_BYTES})`);
  }
  const ctRaw = (r.headers.get("content-type") ?? "image/jpeg").split(";")[0]!.trim();
  const mime = ctRaw.startsWith("image/") ? ctRaw : "image/jpeg";
  return `data:${mime};base64,${uint8ToBase64(buf)}`;
}

function parseScope(params: Record<string, unknown>): Scope {
  const s = isRecord(params.scope) ? (params.scope as Record<string, unknown>) : {};
  return {
    churchId: typeof s.churchId === "string" ? s.churchId : undefined,
    userId: typeof s.userId === "string" ? s.userId : undefined,
    personId: typeof s.personId === "string" ? s.personId : undefined,
    householdId: typeof s.householdId === "string" ? s.householdId : null,
    accountAddress: typeof s.accountAddress === "string" ? s.accountAddress : undefined,
  };
}

function parseAtMs(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && v.trim()) {
    const ms = Date.parse(v);
    if (Number.isFinite(ms)) return ms;
  }
  return nowMs();
}

function numOrNull(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v;
}

type MealAnalysisJson = {
  items?: Array<{
    name?: string;
    portion_g?: number | null;
    calories?: number;
    protein_g?: number;
    carbs_g?: number;
    fat_g?: number;
    fiber_g?: number | null;
    notes?: string;
  }>;
  totals?: {
    calories?: number;
    protein_g?: number;
    carbs_g?: number;
    fat_g?: number;
    fiber_g?: number | null;
  };
  confidence?: number;
  notes?: string;
};

async function telegramGetFileUrl(botToken: string, fileId: string): Promise<string> {
  const u = new URL(`https://api.telegram.org/bot${botToken}/getFile`);
  u.searchParams.set("file_id", fileId);
  const r = await fetch(u.toString());
  const j = (await r.json()) as { ok?: boolean; result?: { file_path?: string }; description?: string };
  if (!j?.ok || !j.result?.file_path) throw new Error(j.description ?? "telegram getFile failed");
  return `https://api.telegram.org/file/bot${botToken}/${j.result.file_path}`;
}

async function telegramFetchFileAsDataUrl(botToken: string, fileId: string): Promise<string> {
  const fileHttpUrl = await telegramGetFileUrl(botToken, fileId);
  return fetchHttpUrlAsDataUrl(fileHttpUrl);
}

async function visionAnalyzeMealPhoto(
  env: Env,
  imageDataUrl: string,
  meal?: string | null,
  locale?: string | null,
): Promise<MealAnalysisJson> {
  const key = env.VISION_API_KEY?.trim();
  if (!key) throw new Error("VISION_API_KEY not configured on weight-management-mcp");
  const baseRaw = (env.VISION_OPENAI_BASE_URL ?? "https://api.openai.com/v1").trim().replace(/\/$/, "");
  let base: string;
  try {
    const u = new URL(baseRaw);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("not http(s)");
    base = baseRaw;
  } catch {
    throw new Error(
      `VISION_OPENAI_BASE_URL must be an absolute http(s) URL; could not parse: ${baseRaw.slice(0, 96)}`,
    );
  }
  const model = env.VISION_MODEL ?? "gpt-4o-mini";
  const system = `You are a nutrition estimation assistant. Return ONLY valid JSON with this exact shape:
{"items":[{"name":"string","portion_g":null,"calories":0,"protein_g":0,"carbs_g":0,"fat_g":0,"fiber_g":null,"notes":""}],
"totals":{"calories":0,"protein_g":0,"carbs_g":0,"fat_g":0,"fiber_g":null},
"confidence":0.5,
"notes":""}
Use realistic estimates; set confidence 0–1 based on image clarity and ambiguity.`;

  const ctxLines = [meal ? `Meal context: ${meal}` : null, locale ? `Locale/prefs: ${locale}` : null].filter(Boolean);
  const userText = ctxLines.length ? ctxLines.join("\n") : "Estimate nutrition for this meal photo.";
  const userContent: Array<Record<string, unknown>> = [{ type: "text", text: userText }];
  // Vision input is always a data URL (bytes); we never send remote http(s) image URLs to the model.
  if (!imageDataUrl.startsWith("data:")) {
    throw new Error("vision: internal error — expected data: URL");
  }
  userContent.push({ type: "image_url", image_url: { url: imageDataUrl } });

  const body = {
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: userContent },
    ],
  };

  const resp = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`vision HTTP ${resp.status}: ${t.slice(0, 600)}`);
  }
  const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("vision: empty content");
  try {
    return JSON.parse(content) as MealAnalysisJson;
  } catch {
    throw new Error("vision: invalid JSON");
  }
}

async function lookupBarcodeOpenFoodFacts(barcode: string): Promise<unknown> {
  const clean = barcode.replace(/\s/g, "");
  if (!/^\d{8,14}$/.test(clean)) throw new Error("Invalid barcode (expect 8–14 digits)");
  const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(clean)}.json`;
  const r = await fetch(url, { headers: { "user-agent": "myclaw-weight-mcp/0.1 (contact: local)" } });
  if (!r.ok) throw new Error(`OpenFoodFacts HTTP ${r.status}`);
  return r.json() as Promise<unknown>;
}

function toolList() {
  const scopeSchema = {
    type: "object",
    properties: {
      churchId: { type: "string" },
      userId: { type: "string" },
      personId: { type: "string" },
      householdId: { type: "string" },
      accountAddress: { type: "string" },
    },
  };

  return [
    { name: "weight_ping", description: "Health check", inputSchema: { type: "object", properties: {} } },
    {
      name: "weight_profile_get",
      description: "Get weight-management profile/settings for this scope.",
      inputSchema: { type: "object", properties: { scope: scopeSchema }, required: ["scope"] },
    },
    {
      name: "weight_profile_upsert",
      description: "Upsert weight-management profile/settings for this scope (targets, preferences).",
      inputSchema: {
        type: "object",
        properties: { scope: scopeSchema, profile: { type: "object" } },
        required: ["scope", "profile"],
      },
    },
    {
      name: "weight_log_weight",
      description: "Log a weigh-in (kg or lb) with optional body fat and notes.",
      inputSchema: {
        type: "object",
        properties: {
          scope: scopeSchema,
          atISO: { type: "string" },
          atMs: { type: "number" },
          weightKg: { type: "number" },
          weightLb: { type: "number" },
          bodyFatPct: { type: "number" },
          notes: { type: "string" },
          source: { type: "string" },
          telegram: {
            type: "object",
            properties: { chatId: { type: "string" }, messageId: { type: "number" } },
          },
        },
        required: ["scope"],
      },
    },
    {
      name: "weight_list_weights",
      description: "List weigh-ins for a scope in a time window.",
      inputSchema: {
        type: "object",
        properties: {
          scope: scopeSchema,
          fromISO: { type: "string" },
          toISO: { type: "string" },
          limit: { type: "number" },
        },
        required: ["scope"],
      },
    },
    {
      name: "weight_log_food",
      description: "Log a food entry (text + optional calories/macros).",
      inputSchema: {
        type: "object",
        properties: {
          scope: scopeSchema,
          atISO: { type: "string" },
          atMs: { type: "number" },
          meal: { type: "string" },
          text: { type: "string" },
          calories: { type: "number" },
          protein_g: { type: "number" },
          carbs_g: { type: "number" },
          fat_g: { type: "number" },
          fiber_g: { type: "number" },
          sugar_g: { type: "number" },
          sodium_mg: { type: "number" },
          source: { type: "string" },
          analysisId: { type: "string" },
          telegram: {
            type: "object",
            properties: { chatId: { type: "string" }, messageId: { type: "number" } },
          },
        },
        required: ["scope", "text"],
      },
    },
    {
      name: "weight_list_food",
      description: "List food entries for a scope in a time window.",
      inputSchema: {
        type: "object",
        properties: { scope: scopeSchema, fromISO: { type: "string" }, toISO: { type: "string" }, limit: { type: "number" } },
        required: ["scope"],
      },
    },
    {
      name: "weight_log_photo",
      description: "Log a photo reference (e.g. meal/body progress) with optional Telegram metadata.",
      inputSchema: {
        type: "object",
        properties: {
          scope: scopeSchema,
          atISO: { type: "string" },
          atMs: { type: "number" },
          kind: { type: "string" },
          caption: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          telegram: {
            type: "object",
            properties: {
              chatId: { type: "string" },
              messageId: { type: "number" },
              fileId: { type: "string" },
              fileUniqueId: { type: "string" },
            },
          },
          photoUrl: { type: "string" },
        },
        required: ["scope", "kind"],
      },
    },
    {
      name: "weight_list_photos",
      description: "List logged photos for a scope in a time window.",
      inputSchema: {
        type: "object",
        properties: { scope: scopeSchema, fromISO: { type: "string" }, toISO: { type: "string" }, limit: { type: "number" } },
        required: ["scope"],
      },
    },
    {
      name: "weight_ingest_telegram_message",
      description:
        "Store a Telegram message (and optional photo refs) as weight-management context. This tool does not interpret the message; it persists it for later queries.",
      inputSchema: {
        type: "object",
        properties: {
          scope: scopeSchema,
          chatId: { type: "string" },
          messageId: { type: "number" },
          fromUserId: { type: "number" },
          dateUnix: { type: "number" },
          text: { type: "string" },
          caption: { type: "string" },
          photos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                fileId: { type: "string" },
                fileUniqueId: { type: "string" },
                width: { type: "number" },
                height: { type: "number" },
                photoUrl: { type: "string" }
              },
              required: ["fileId"]
            }
          }
        },
        required: ["scope", "chatId", "messageId"]
      }
    },
    {
      name: "weight_day_summary",
      description:
        "Summarize a day: weights, food calories/macros totals, water, daily targets (if set), photo count, meal analyses count.",
      inputSchema: {
        type: "object",
        properties: { scope: scopeSchema, dateISO: { type: "string" } },
        required: ["scope"],
      },
    },
    {
      name: "weight_analyze_meal_photo",
      description:
        "Estimate calories/macros from a meal image via vision API; persist row in wm_meal_analyses. Supply image bytes: imageBase64 (raw base64 or data:image/... URL) and/or telegram.fileId (worker downloads via Bot API and inlines bytes). Optional imageUrl (https) is fetched server-side and inlined — prefer base64 + fileId; never rely on passing image URLs to the model.",
      inputSchema: {
        type: "object",
        properties: {
          scope: scopeSchema,
          meal: { type: "string" },
          locale: { type: "string" },
          imageUrl: { type: "string", description: "Optional; fetched and inlined as bytes before vision." },
          imageBase64: { type: "string" },
          telegram: {
            type: "object",
            properties: {
              fileId: { type: "string" },
              botToken: { type: "string" },
              chatId: { type: "string" },
              messageId: { type: "number" },
            },
          },
          atMs: { type: "number" },
          atISO: { type: "string" },
        },
        required: ["scope"],
      },
    },
    {
      name: "weight_log_food_from_analysis",
      description:
        "Create wm_food_entries from a prior weight_analyze_meal_photo analysis (items = one row per detected food; aggregate = single row with totals).",
      inputSchema: {
        type: "object",
        properties: {
          scope: scopeSchema,
          analysisId: { type: "string" },
          mode: { type: "string", enum: ["items", "aggregate"] },
          atMs: { type: "number" },
          atISO: { type: "string" },
          meal: { type: "string" },
          source: { type: "string" },
          telegram: {
            type: "object",
            properties: { chatId: { type: "string" }, messageId: { type: "number" } },
          },
        },
        required: ["scope", "analysisId"],
      },
    },
    {
      name: "weight_lookup_barcode",
      description: "Look up product nutrition via Open Food Facts (barcode digits).",
      inputSchema: {
        type: "object",
        properties: { scope: scopeSchema, barcode: { type: "string" } },
        required: ["scope", "barcode"],
      },
    },
    {
      name: "weight_target_get",
      description: "Get daily nutrition/water/steps targets JSON for this scope.",
      inputSchema: { type: "object", properties: { scope: scopeSchema }, required: ["scope"] },
    },
    {
      name: "weight_target_upsert",
      description:
        "Upsert daily targets JSON, e.g. {calories,protein_g,carbs_g,fat_g,fiber_g,sodium_mg,water_ml_day,steps} (fields optional).",
      inputSchema: {
        type: "object",
        properties: { scope: scopeSchema, targets: { type: "object" } },
        required: ["scope", "targets"],
      },
    },
    {
      name: "weight_water_log",
      description: "Log water intake (ml).",
      inputSchema: {
        type: "object",
        properties: {
          scope: scopeSchema,
          amount_ml: { type: "number" },
          atMs: { type: "number" },
          atISO: { type: "string" },
          source: { type: "string" },
          telegram: {
            type: "object",
            properties: { chatId: { type: "string" }, messageId: { type: "number" } },
          },
        },
        required: ["scope", "amount_ml"],
      },
    },
    {
      name: "weight_water_list",
      description: "List water log rows in a time window.",
      inputSchema: {
        type: "object",
        properties: { scope: scopeSchema, fromISO: { type: "string" }, toISO: { type: "string" }, limit: { type: "number" } },
        required: ["scope"],
      },
    },
    {
      name: "weight_fast_start",
      description: "Start a fasting window (end_ms null until weight_fast_end).",
      inputSchema: {
        type: "object",
        properties: {
          scope: scopeSchema,
          label: { type: "string" },
          startMs: { type: "number" },
          startISO: { type: "string" },
          source: { type: "string" },
        },
        required: ["scope"],
      },
    },
    {
      name: "weight_fast_end",
      description: "End a fast: pass fastId, or closeLatest=true to close the latest open window for this scope.",
      inputSchema: {
        type: "object",
        properties: {
          scope: scopeSchema,
          fastId: { type: "string" },
          closeLatest: { type: "boolean" },
          endMs: { type: "number" },
          endISO: { type: "string" },
        },
        required: ["scope"],
      },
    },
    {
      name: "weight_fast_list",
      description: "List fasting windows (optional time range).",
      inputSchema: {
        type: "object",
        properties: { scope: scopeSchema, fromISO: { type: "string" }, toISO: { type: "string" }, limit: { type: "number" } },
        required: ["scope"],
      },
    },
    {
      name: "weight_week_summary",
      description: "Aggregate food + water per day for ISO week starting Monday (UTC); include targets if configured.",
      inputSchema: {
        type: "object",
        properties: { scope: scopeSchema, weekStartISO: { type: "string" } },
        required: ["scope"],
      },
    },
  ];
}

async function toolCall(env: Env, name: string, args: Record<string, unknown>): Promise<unknown> {
  const scope = parseScope(args);
  const sid = scopeId(scope);

  if (name === "weight_ping") return { ok: true, ts: nowMs() };

  if (name === "weight_profile_get") {
    const row = await env.DB.prepare(`SELECT profile_json, updated_at FROM wm_profiles WHERE scope_id=?1 LIMIT 1`)
      .bind(sid)
      .first<{ profile_json: string; updated_at: number }>();
    return { ok: true, scope_id: sid, profile: row ? JSON.parse(row.profile_json) : {}, updated_at: row?.updated_at ?? null };
  }

  if (name === "weight_profile_upsert") {
    const profile = isRecord(args.profile) ? args.profile : {};
    const ts = nowMs();
    await env.DB.prepare(
      `INSERT INTO wm_profiles (scope_id, scope_json, profile_json, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(scope_id) DO UPDATE SET profile_json=excluded.profile_json, updated_at=excluded.updated_at`,
    )
      .bind(sid, JSON.stringify(scope), JSON.stringify(profile), ts)
      .run();
    return { ok: true, scope_id: sid, updated_at: ts };
  }

  if (name === "weight_log_weight") {
    const id = crypto.randomUUID();
    const at_ms = "atMs" in args ? parseAtMs(args.atMs) : parseAtMs(args.atISO);
    const weightKg = numOrNull(args.weightKg);
    const weightLb = numOrNull(args.weightLb);
    const bodyfat = numOrNull(args.bodyFatPct);
    const notes = normStr(args.notes);
    const source = normStr(args.source);
    const telegram = isRecord(args.telegram) ? (args.telegram as Record<string, unknown>) : null;
    const chatId = telegram ? normStr(telegram.chatId) : null;
    const messageId = telegram && typeof telegram.messageId === "number" ? Math.trunc(telegram.messageId) : null;

    const kg =
      weightKg ??
      (weightLb != null ? weightLb * 0.45359237 : null);
    if (kg == null) throw new Error("Provide weightKg or weightLb");

    const ts = nowMs();
    await env.DB.prepare(
      `INSERT INTO wm_weights (id, scope_id, at_ms, weight_kg, bodyfat_pct, notes, source, telegram_chat_id, telegram_message_id, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`,
    )
      .bind(id, sid, at_ms, kg, bodyfat, notes, source, chatId, messageId, ts)
      .run();

    return { ok: true, id, scope_id: sid, at_ms, weight_kg: kg };
  }

  if (name === "weight_list_weights") {
    const from = "fromISO" in args ? Date.parse(String(args.fromISO)) : NaN;
    const to = "toISO" in args ? Date.parse(String(args.toISO)) : NaN;
    const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.min(200, Math.max(1, Math.trunc(args.limit))) : 50;
    const where: string[] = ["scope_id=?1"];
    const binds: unknown[] = [sid];
    if (Number.isFinite(from)) {
      where.push("at_ms >= ?2");
      binds.push(from);
    }
    if (Number.isFinite(to)) {
      where.push(`at_ms <= ?${binds.length + 1}`);
      binds.push(to);
    }
    const sql = `SELECT id, at_ms, weight_kg, bodyfat_pct, notes, source, telegram_chat_id, telegram_message_id
                 FROM wm_weights
                 WHERE ${where.join(" AND ")}
                 ORDER BY at_ms DESC
                 LIMIT ${limit}`;
    const res = await env.DB.prepare(sql).bind(...binds).all();
    return { ok: true, scope_id: sid, items: res.results ?? [] };
  }

  if (name === "weight_log_food") {
    const id = crypto.randomUUID();
    const at_ms = "atMs" in args ? parseAtMs(args.atMs) : parseAtMs(args.atISO);
    const meal = normStr(args.meal);
    const text = normStr(args.text);
    if (!text) throw new Error("Missing text");
    const ts = nowMs();
    const telegram = isRecord(args.telegram) ? (args.telegram as Record<string, unknown>) : null;
    const chatId = telegram ? normStr(telegram.chatId) : null;
    const messageId = telegram && typeof telegram.messageId === "number" ? Math.trunc(telegram.messageId) : null;
    const analysisId = normStr(args.analysisId);
    await env.DB.prepare(
      `INSERT INTO wm_food_entries
       (id, scope_id, at_ms, meal, text, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, source, telegram_chat_id, telegram_message_id, analysis_id, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)`,
    )
      .bind(
        id,
        sid,
        at_ms,
        meal,
        text,
        numOrNull(args.calories),
        numOrNull(args.protein_g),
        numOrNull(args.carbs_g),
        numOrNull(args.fat_g),
        numOrNull(args.fiber_g),
        numOrNull(args.sugar_g),
        numOrNull(args.sodium_mg),
        normStr(args.source),
        chatId,
        messageId,
        analysisId,
        ts,
      )
      .run();
    return { ok: true, id, scope_id: sid, at_ms, meal, text };
  }

  if (name === "weight_list_food") {
    const from = "fromISO" in args ? Date.parse(String(args.fromISO)) : NaN;
    const to = "toISO" in args ? Date.parse(String(args.toISO)) : NaN;
    const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.min(200, Math.max(1, Math.trunc(args.limit))) : 50;
    const where: string[] = ["scope_id=?1"];
    const binds: unknown[] = [sid];
    if (Number.isFinite(from)) {
      where.push("at_ms >= ?2");
      binds.push(from);
    }
    if (Number.isFinite(to)) {
      where.push(`at_ms <= ?${binds.length + 1}`);
      binds.push(to);
    }
    const sql = `SELECT id, at_ms, meal, text, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, source, telegram_chat_id, telegram_message_id
                 FROM wm_food_entries
                 WHERE ${where.join(" AND ")}
                 ORDER BY at_ms DESC
                 LIMIT ${limit}`;
    const res = await env.DB.prepare(sql).bind(...binds).all();
    return { ok: true, scope_id: sid, items: res.results ?? [] };
  }

  if (name === "weight_log_photo") {
    const id = crypto.randomUUID();
    const at_ms = "atMs" in args ? parseAtMs(args.atMs) : parseAtMs(args.atISO);
    const kind = normStr(args.kind) ?? "other";
    const caption = normStr(args.caption);
    const tags = Array.isArray(args.tags) ? args.tags.filter((t) => typeof t === "string") : [];
    const telegram = isRecord(args.telegram) ? (args.telegram as Record<string, unknown>) : null;
    const chatId = telegram ? normStr(telegram.chatId) : null;
    const messageId = telegram && typeof telegram.messageId === "number" ? Math.trunc(telegram.messageId) : null;
    const fileId = telegram ? normStr(telegram.fileId) : null;
    const fileUniqueId = telegram ? normStr(telegram.fileUniqueId) : null;
    const photoUrl = normStr(args.photoUrl);
    const ts = nowMs();
    await env.DB.prepare(
      `INSERT INTO wm_photos
       (id, scope_id, at_ms, kind, caption, tags_json, telegram_chat_id, telegram_message_id, telegram_file_id, telegram_file_unique_id, photo_url, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`,
    )
      .bind(id, sid, at_ms, kind, caption, JSON.stringify(tags), chatId, messageId, fileId, fileUniqueId, photoUrl, ts)
      .run();
    return { ok: true, id, scope_id: sid, at_ms, kind };
  }

  if (name === "weight_list_photos") {
    const from = "fromISO" in args ? Date.parse(String(args.fromISO)) : NaN;
    const to = "toISO" in args ? Date.parse(String(args.toISO)) : NaN;
    const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.min(200, Math.max(1, Math.trunc(args.limit))) : 50;
    const where: string[] = ["scope_id=?1"];
    const binds: unknown[] = [sid];
    if (Number.isFinite(from)) {
      where.push("at_ms >= ?2");
      binds.push(from);
    }
    if (Number.isFinite(to)) {
      where.push(`at_ms <= ?${binds.length + 1}`);
      binds.push(to);
    }
    const sql = `SELECT id, at_ms, kind, caption, tags_json, telegram_chat_id, telegram_message_id, telegram_file_id, photo_url
                 FROM wm_photos
                 WHERE ${where.join(" AND ")}
                 ORDER BY at_ms DESC
                 LIMIT ${limit}`;
    const res = await env.DB.prepare(sql).bind(...binds).all();
    const items = (res.results ?? []).map((r) => ({
      ...r,
      tags: typeof (r as any).tags_json === "string" ? JSON.parse((r as any).tags_json) : [],
    }));
    return { ok: true, scope_id: sid, items };
  }

  if (name === "weight_ingest_telegram_message") {
    const chatId = normStr(args.chatId);
    const messageId = typeof args.messageId === "number" ? Math.trunc(args.messageId) : null;
    if (!chatId || messageId == null) throw new Error("Missing chatId/messageId");
    const fromUserId = typeof args.fromUserId === "number" ? Math.trunc(args.fromUserId) : null;
    const dateUnix = typeof args.dateUnix === "number" ? Math.trunc(args.dateUnix) : null;
    const at_ms = dateUnix != null ? dateUnix * 1000 : nowMs();
    const text = normStr(args.text);
    const caption = normStr(args.caption);
    const photos = Array.isArray(args.photos) ? args.photos.filter((p) => isRecord(p)) : [];
    const payload = { chatId, messageId, fromUserId, dateUnix, text, caption, photos };

    const evId = crypto.randomUUID();
    const ts = nowMs();
    await env.DB.prepare(
      `INSERT INTO wm_events (id, scope_id, type, at_ms, payload_json, created_at)
       VALUES (?1,?2,?3,?4,?5,?6)`,
    )
      .bind(evId, sid, "telegram.message", at_ms, JSON.stringify(payload), ts)
      .run();

    // Also store photo refs if provided.
    for (const p of photos) {
      const fileId = normStr((p as any).fileId);
      if (!fileId) continue;
      const photoId = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO wm_photos
         (id, scope_id, at_ms, kind, caption, tags_json, telegram_chat_id, telegram_message_id, telegram_file_id, telegram_file_unique_id, photo_url, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`,
      )
        .bind(
          photoId,
          sid,
          at_ms,
          "telegram",
          caption,
          JSON.stringify([]),
          chatId,
          messageId,
          fileId,
          normStr((p as any).fileUniqueId),
          normStr((p as any).photoUrl),
          ts,
        )
        .run();
    }

    return { ok: true, scope_id: sid, stored: { eventId: evId, photos: photos.length } };
  }

  if (name === "weight_day_summary") {
    const dateISO = normStr(args.dateISO) ?? new Date().toISOString().slice(0, 10);
    const dayStart = Date.parse(`${dateISO}T00:00:00.000Z`);
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;

    const weights = await env.DB.prepare(
      `SELECT id, at_ms, weight_kg, bodyfat_pct, notes FROM wm_weights
       WHERE scope_id=?1 AND at_ms>=?2 AND at_ms<?3
       ORDER BY at_ms DESC LIMIT 10`,
    )
      .bind(sid, dayStart, dayEnd)
      .all();

    const foods = await env.DB.prepare(
      `SELECT calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg FROM wm_food_entries
       WHERE scope_id=?1 AND at_ms>=?2 AND at_ms<?3`,
    )
      .bind(sid, dayStart, dayEnd)
      .all();

    let calories = 0;
    let protein_g = 0;
    let carbs_g = 0;
    let fat_g = 0;
    for (const r of foods.results ?? []) {
      calories += typeof (r as any).calories === "number" ? (r as any).calories : 0;
      protein_g += typeof (r as any).protein_g === "number" ? (r as any).protein_g : 0;
      carbs_g += typeof (r as any).carbs_g === "number" ? (r as any).carbs_g : 0;
      fat_g += typeof (r as any).fat_g === "number" ? (r as any).fat_g : 0;
    }

    const photoCount = await env.DB.prepare(
      `SELECT COUNT(1) as c FROM wm_photos WHERE scope_id=?1 AND at_ms>=?2 AND at_ms<?3`,
    )
      .bind(sid, dayStart, dayEnd)
      .first<{ c: number }>();

    const waterRow = await env.DB.prepare(
      `SELECT COALESCE(SUM(amount_ml),0) as w FROM wm_water_log WHERE scope_id=?1 AND at_ms>=?2 AND at_ms<?3`,
    )
      .bind(sid, dayStart, dayEnd)
      .first<{ w: number }>();

    const analysisCount = await env.DB.prepare(
      `SELECT COUNT(1) as c FROM wm_meal_analyses WHERE scope_id=?1 AND at_ms>=?2 AND at_ms<?3`,
    )
      .bind(sid, dayStart, dayEnd)
      .first<{ c: number }>();

    const targetsRow = await env.DB.prepare(`SELECT targets_json, updated_at FROM wm_daily_targets WHERE scope_id=?1 LIMIT 1`)
      .bind(sid)
      .first<{ targets_json: string; updated_at: number }>();

    return {
      ok: true,
      scope_id: sid,
      dateISO,
      weights: weights.results ?? [],
      totals: { calories, protein_g, carbs_g, fat_g },
      water_ml: waterRow?.w ?? 0,
      photoCount: photoCount?.c ?? 0,
      mealAnalysesCount: analysisCount?.c ?? 0,
      targets: targetsRow ? JSON.parse(targetsRow.targets_json) : null,
      targets_updated_at: targetsRow?.updated_at ?? null,
    };
  }

  if (name === "weight_analyze_meal_photo") {
    const tg = isRecord(args.telegram) ? (args.telegram as Record<string, unknown>) : null;
    const fileId = tg ? normStr(tg.fileId) : null;
    const botToken = (tg && normStr(tg.botToken)) || env.TELEGRAM_BOT_TOKEN?.trim() || "";
    const rawB64 = normStr(args.imageBase64);
    const imageUrlArg = normStr(args.imageUrl);

    let imageDataUrl: string;
    if (rawB64) {
      imageDataUrl = rawB64.startsWith("data:") ? rawB64 : `data:image/jpeg;base64,${rawB64}`;
    } else if (fileId) {
      if (!botToken) throw new Error("telegram.fileId requires TELEGRAM_BOT_TOKEN on worker or telegram.botToken in args");
      imageDataUrl = await telegramFetchFileAsDataUrl(botToken, fileId);
    } else if (imageUrlArg && isFetchableHttpsImageUrl(imageUrlArg)) {
      imageDataUrl = await fetchHttpUrlAsDataUrl(imageUrlArg);
    } else {
      throw new Error("Provide imageBase64, telegram.fileId (+ token), or an https imageUrl to fetch and inline");
    }

    const analysis = await visionAnalyzeMealPhoto(env, imageDataUrl, normStr(args.meal), normStr(args.locale));
    const at_ms = "atMs" in args ? parseAtMs(args.atMs) : parseAtMs(args.atISO);
    const ts = nowMs();
    const id = crypto.randomUUID();
    const totals = analysis.totals ?? {};
    const summary =
      typeof totals.calories === "number"
        ? `~${Math.round(totals.calories)} kcal (confidence ${typeof analysis.confidence === "number" ? analysis.confidence.toFixed(2) : "?"})`
        : "meal analysis";
    const imageRef: Record<string, unknown> = { vision_input: "data_url_bytes_only" };
    if (fileId) imageRef.telegram = { fileId };
    if (rawB64) imageRef.imageBase64_sha_prefix = rawB64.slice(0, 24);
    if (imageUrlArg && !rawB64 && !fileId) imageRef.inlined_from_https = true;
    await env.DB.prepare(
      `INSERT INTO wm_meal_analyses
       (id, scope_id, at_ms, model, summary, raw_json, image_ref_json, telegram_chat_id, telegram_message_id, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`,
    )
      .bind(
        id,
        sid,
        at_ms,
        model,
        summary,
        JSON.stringify(analysis),
        JSON.stringify(imageRef),
        tg ? normStr(tg.chatId) : null,
        tg && typeof tg.messageId === "number" ? Math.trunc(tg.messageId) : null,
        ts,
      )
      .run();
    return { ok: true, analysisId: id, scope_id: sid, at_ms, model, summary, analysis };
  }

  if (name === "weight_log_food_from_analysis") {
    const analysisId = normStr(args.analysisId);
    if (!analysisId) throw new Error("Missing analysisId");
    const row = await env.DB.prepare(`SELECT raw_json FROM wm_meal_analyses WHERE id=?1 AND scope_id=?2 LIMIT 1`)
      .bind(analysisId, sid)
      .first<{ raw_json: string }>();
    if (!row) throw new Error("analysis not found for scope");
    const parsed = JSON.parse(row.raw_json) as MealAnalysisJson;
    const mode = normStr(args.mode) === "aggregate" ? "aggregate" : "items";
    const at_ms = "atMs" in args ? parseAtMs(args.atMs) : parseAtMs(args.atISO);
    const meal = normStr(args.meal);
    const source = normStr(args.source) ?? "meal_photo_analysis";
    const telegram = isRecord(args.telegram) ? (args.telegram as Record<string, unknown>) : null;
    const chatId = telegram ? normStr(telegram.chatId) : null;
    const messageId = telegram && typeof telegram.messageId === "number" ? Math.trunc(telegram.messageId) : null;
    const ts = nowMs();
    const createdIds: string[] = [];

    if (mode === "aggregate") {
      const t = parsed.totals ?? {};
      const fid = crypto.randomUUID();
      const text =
        parsed.notes?.trim() ||
        `Meal (from photo analysis${parsed.confidence != null ? `, conf ${parsed.confidence}` : ""})`;
      await env.DB.prepare(
        `INSERT INTO wm_food_entries
         (id, scope_id, at_ms, meal, text, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, source, telegram_chat_id, telegram_message_id, analysis_id, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)`,
      )
        .bind(
          fid,
          sid,
          at_ms,
          meal,
          text,
          numOrNull(t.calories),
          numOrNull(t.protein_g),
          numOrNull(t.carbs_g),
          numOrNull(t.fat_g),
          numOrNull(t.fiber_g),
          null,
          null,
          source,
          chatId,
          messageId,
          analysisId,
          ts,
        )
        .run();
      createdIds.push(fid);
    } else {
      const items = Array.isArray(parsed.items) ? parsed.items : [];
      for (const it of items) {
        const fid = crypto.randomUUID();
        const text = typeof it.name === "string" && it.name.trim() ? it.name.trim() : "food item";
        const notes = typeof it.notes === "string" && it.notes.trim() ? it.notes.trim() : "";
        const line = notes ? `${text} — ${notes}` : text;
        await env.DB.prepare(
          `INSERT INTO wm_food_entries
           (id, scope_id, at_ms, meal, text, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, source, telegram_chat_id, telegram_message_id, analysis_id, created_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)`,
        )
          .bind(
            fid,
            sid,
            at_ms,
            meal,
            line,
            numOrNull(it.calories),
            numOrNull(it.protein_g),
            numOrNull(it.carbs_g),
            numOrNull(it.fat_g),
            numOrNull(it.fiber_g),
            null,
            null,
            source,
            chatId,
            messageId,
            analysisId,
            ts,
          )
          .run();
        createdIds.push(fid);
      }
    }

    return { ok: true, scope_id: sid, analysisId, mode, foodEntryIds: createdIds, count: createdIds.length };
  }

  if (name === "weight_lookup_barcode") {
    const raw = await lookupBarcodeOpenFoodFacts(normStr(args.barcode) ?? "");
    return { ok: true, scope_id: sid, product: raw };
  }

  if (name === "weight_target_get") {
    const row = await env.DB.prepare(`SELECT targets_json, updated_at FROM wm_daily_targets WHERE scope_id=?1 LIMIT 1`)
      .bind(sid)
      .first<{ targets_json: string; updated_at: number }>();
    return { ok: true, scope_id: sid, targets: row ? JSON.parse(row.targets_json) : {}, updated_at: row?.updated_at ?? null };
  }

  if (name === "weight_target_upsert") {
    const targets = isRecord(args.targets) ? args.targets : {};
    const ts = nowMs();
    await env.DB.prepare(
      `INSERT INTO wm_daily_targets (scope_id, targets_json, updated_at) VALUES (?1,?2,?3)
       ON CONFLICT(scope_id) DO UPDATE SET targets_json=excluded.targets_json, updated_at=excluded.updated_at`,
    )
      .bind(sid, JSON.stringify(targets), ts)
      .run();
    return { ok: true, scope_id: sid, updated_at: ts };
  }

  if (name === "weight_water_log") {
    const at_ms = "atMs" in args ? parseAtMs(args.atMs) : parseAtMs(args.atISO);
    const amount = numOrNull(args.amount_ml);
    if (amount == null || amount <= 0) throw new Error("amount_ml required");
    const telegram = isRecord(args.telegram) ? (args.telegram as Record<string, unknown>) : null;
    const chatId = telegram ? normStr(telegram.chatId) : null;
    const messageId = telegram && typeof telegram.messageId === "number" ? Math.trunc(telegram.messageId) : null;
    const id = crypto.randomUUID();
    const ts = nowMs();
    await env.DB.prepare(
      `INSERT INTO wm_water_log (id, scope_id, at_ms, amount_ml, source, telegram_chat_id, telegram_message_id, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
    )
      .bind(id, sid, at_ms, amount, normStr(args.source), chatId, messageId, ts)
      .run();
    return { ok: true, id, scope_id: sid, at_ms, amount_ml: amount };
  }

  if (name === "weight_water_list") {
    const from = "fromISO" in args ? Date.parse(String(args.fromISO)) : NaN;
    const to = "toISO" in args ? Date.parse(String(args.toISO)) : NaN;
    const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.min(200, Math.max(1, Math.trunc(args.limit))) : 50;
    const where: string[] = ["scope_id=?1"];
    const binds: unknown[] = [sid];
    if (Number.isFinite(from)) {
      where.push("at_ms >= ?2");
      binds.push(from);
    }
    if (Number.isFinite(to)) {
      where.push(`at_ms <= ?${binds.length + 1}`);
      binds.push(to);
    }
    const q = `SELECT * FROM wm_water_log WHERE ${where.join(" AND ")} ORDER BY at_ms DESC LIMIT ?${binds.length + 1}`;
    binds.push(limit);
    const rows = await env.DB.prepare(q).bind(...binds).all();
    return { ok: true, scope_id: sid, rows: rows.results ?? [] };
  }

  if (name === "weight_fast_start") {
    const start_ms = "startMs" in args ? parseAtMs(args.startMs) : parseAtMs(args.startISO);
    const id = crypto.randomUUID();
    const ts = nowMs();
    await env.DB.prepare(
      `INSERT INTO wm_fast_windows (id, scope_id, start_ms, end_ms, label, source, created_at)
       VALUES (?1,?2,?3,NULL,?4,?5,?6)`,
    )
      .bind(id, sid, start_ms, normStr(args.label), normStr(args.source), ts)
      .run();
    return { ok: true, fastId: id, scope_id: sid, start_ms };
  }

  if (name === "weight_fast_end") {
    const end_ms =
      "endMs" in args && typeof args.endMs === "number"
        ? parseAtMs(args.endMs)
        : "endISO" in args && typeof args.endISO === "string"
          ? parseAtMs(args.endISO)
          : nowMs();
    const fastId = normStr(args.fastId);
    const closeLatest = args.closeLatest === true;
    if (!fastId && !closeLatest) throw new Error("Provide fastId or closeLatest=true");
    let row: { id: string } | null = null;
    if (closeLatest) {
      row = await env.DB.prepare(
        `SELECT id FROM wm_fast_windows WHERE scope_id=?1 AND end_ms IS NULL ORDER BY start_ms DESC LIMIT 1`,
      )
        .bind(sid)
        .first<{ id: string }>();
      if (!row) return { ok: true, scope_id: sid, updated: false, note: "no open fast" };
    } else {
      row = { id: fastId! };
    }
    await env.DB.prepare(`UPDATE wm_fast_windows SET end_ms=?1 WHERE id=?2 AND scope_id=?3`)
      .bind(end_ms, row.id, sid)
      .run();
    return { ok: true, scope_id: sid, fastId: row.id, end_ms, updated: true };
  }

  if (name === "weight_fast_list") {
    const from = "fromISO" in args ? Date.parse(String(args.fromISO)) : NaN;
    const to = "toISO" in args ? Date.parse(String(args.toISO)) : NaN;
    const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.min(200, Math.max(1, Math.trunc(args.limit))) : 50;
    const where: string[] = ["scope_id=?1"];
    const binds: unknown[] = [sid];
    if (Number.isFinite(from)) {
      where.push("start_ms >= ?2");
      binds.push(from);
    }
    if (Number.isFinite(to)) {
      where.push(`COALESCE(end_ms, start_ms) <= ?${binds.length + 1}`);
      binds.push(to);
    }
    const q = `SELECT * FROM wm_fast_windows WHERE ${where.join(" AND ")} ORDER BY start_ms DESC LIMIT ?${binds.length + 1}`;
    binds.push(limit);
    const rows = await env.DB.prepare(q).bind(...binds).all();
    return { ok: true, scope_id: sid, rows: rows.results ?? [] };
  }

  if (name === "weight_week_summary") {
    const ref = normStr(args.weekStartISO);
    const refMs = ref ? Date.parse(`${ref}T12:00:00.000Z`) : Date.now();
    const monday = new Date(refMs);
    const dow = monday.getUTCDay();
    const diff = (dow + 6) % 7;
    monday.setUTCDate(monday.getUTCDate() - diff);
    const weekStartISO = monday.toISOString().slice(0, 10);
    const weekStartMs = Date.parse(`${weekStartISO}T00:00:00.000Z`);
    const weekEndMs = weekStartMs + 7 * 86400000;

    const targetsRow = await env.DB.prepare(`SELECT targets_json FROM wm_daily_targets WHERE scope_id=?1 LIMIT 1`)
      .bind(sid)
      .first<{ targets_json: string }>();
    const targets = targetsRow ? (JSON.parse(targetsRow.targets_json) as Record<string, unknown>) : null;

    const days: Array<{
      dateISO: string;
      totals: { calories: number; protein_g: number; carbs_g: number; fat_g: number };
      water_ml: number;
      weight_count: number;
    }> = [];

    for (let i = 0; i < 7; i++) {
      const d0 = new Date(weekStartMs + i * 86400000);
      const dateISO = d0.toISOString().slice(0, 10);
      const dayStart = Date.parse(`${dateISO}T00:00:00.000Z`);
      const dayEnd = dayStart + 86400000;

      const foods = await env.DB.prepare(
        `SELECT calories, protein_g, carbs_g, fat_g FROM wm_food_entries WHERE scope_id=?1 AND at_ms>=?2 AND at_ms<?3`,
      )
        .bind(sid, dayStart, dayEnd)
        .all();
      let calories = 0;
      let protein_g = 0;
      let carbs_g = 0;
      let fat_g = 0;
      for (const r of foods.results ?? []) {
        const rr = r as Record<string, unknown>;
        calories += typeof rr.calories === "number" ? rr.calories : 0;
        protein_g += typeof rr.protein_g === "number" ? rr.protein_g : 0;
        carbs_g += typeof rr.carbs_g === "number" ? rr.carbs_g : 0;
        fat_g += typeof rr.fat_g === "number" ? rr.fat_g : 0;
      }
      const wrow = await env.DB.prepare(
        `SELECT COALESCE(SUM(amount_ml),0) as w FROM wm_water_log WHERE scope_id=?1 AND at_ms>=?2 AND at_ms<?3`,
      )
        .bind(sid, dayStart, dayEnd)
        .first<{ w: number }>();
      const wc = await env.DB.prepare(
        `SELECT COUNT(1) as c FROM wm_weights WHERE scope_id=?1 AND at_ms>=?2 AND at_ms<?3`,
      )
        .bind(sid, dayStart, dayEnd)
        .first<{ c: number }>();

      days.push({
        dateISO,
        totals: { calories, protein_g, carbs_g, fat_g },
        water_ml: wrow?.w ?? 0,
        weight_count: wc?.c ?? 0,
      });
    }

    const tCal = typeof targets?.calories === "number" ? targets.calories : null;
    const tWater = typeof targets?.water_ml_day === "number" ? targets.water_ml_day : null;

    return {
      ok: true,
      scope_id: sid,
      weekStartISO,
      weekEndISO: new Date(weekEndMs).toISOString().slice(0, 10),
      targets,
      days,
      hints:
        tCal != null || tWater != null
          ? {
              avg_daily_calories: days.reduce((s, d) => s + d.totals.calories, 0) / 7,
              target_calories: tCal,
              avg_daily_water_ml: days.reduce((s, d) => s + d.water_ml, 0) / 7,
              target_water_ml_day: tWater,
            }
          : undefined,
    };
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function handleMcp(req: Request, env: Env): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: cors(req) });

  requireAuth(req, env);

  let body: JsonRpcRequest | null = null;
  try {
    body = (await req.json()) as JsonRpcRequest;
  } catch {
    return json({ error: "invalid_json" }, { status: 400, headers: cors(req) });
  }

  const id = body?.id ?? 1;
  const method = body?.method ?? "";
  const params = isRecord(body?.params) ? (body!.params as Record<string, unknown>) : {};

  let resp: unknown;
  try {
    if (method === "tools/list") {
      weightMcpLog(env, "jsonrpc", { method: "tools/list" });
      const tools = toolList();
      weightMcpLog(env, "jsonrpc_ok", { method: "tools/list", toolCount: tools.length });
      resp = { jsonrpc: "2.0", id, result: { tools } };
    } else if (method === "tools/call") {
      const name = normStr(params.name);
      const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      if (!name) resp = errResult(id, -32602, "Missing tool name");
      else {
        const t0 = Date.now();
        weightMcpLog(env, "tools/call", { tool: name, args: summarizeWeightToolArgs(name, args) });
        const out = await toolCall(env, name, args);
        weightMcpLog(env, "tools/call_ok", { tool: name, ms: Date.now() - t0 });
        resp = okResult(id, JSON.stringify(out, null, 2));
      }
    } else {
      weightMcpLog(env, "jsonrpc_unknown_method", { method });
      resp = errResult(id, -32601, `Unknown method: ${method}`);
    }
  } catch (e) {
    if (e instanceof Response) return e;
    weightMcpLog(env, "jsonrpc_error", { method, error: (e as Error).message });
    resp = errResult(id, -32603, (e as Error).message);
  }

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sseJson(resp)));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-store", ...cors(req) },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return json({ ok: true, ts: nowMs() }, { headers: cors(req) });
    if (url.pathname === "/mcp") {
      weightMcpLog(env, "http_enter", { path: "/mcp", method: req.method });
      return handleMcp(req, env);
    }
    return new Response("Not Found", { status: 404, headers: cors(req) });
  },
};

