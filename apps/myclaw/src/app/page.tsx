"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type ThreadSummary = {
  thread_id: string;
  created_at?: string;
  updated_at?: string;
  metadata?: unknown;
};

type SseEvent =
  | { event: "thread"; data: { thread_id: string } }
  | { event: "delta"; data: { text: string } }
  | {
      event: "final";
      data: {
        thread_id: string;
        message: string;
        entities: unknown[];
        suggestedActions: unknown[];
      };
    };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function parseSseChunk(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? "";

  for (const part of parts) {
    const lines = part.split(/\r?\n/);
    const eventLine = lines.find((l) => l.startsWith("event: "));
    const dataLine = lines.find((l) => l.startsWith("data: "));
    if (!eventLine || !dataLine) continue;

    const event = eventLine.slice("event: ".length).trim();
    const dataRaw = dataLine.slice("data: ".length).trim();
    try {
      const data = JSON.parse(dataRaw) as unknown;
      if (event === "thread" && isRecord(data) && typeof data.thread_id === "string") {
        events.push({ event: "thread", data: { thread_id: data.thread_id } });
      }
      if (event === "delta" && isRecord(data) && typeof data.text === "string") {
        events.push({ event: "delta", data: { text: data.text } });
      }
      if (
        event === "final" &&
        isRecord(data) &&
        typeof data.thread_id === "string" &&
        typeof data.message === "string" &&
        Array.isArray(data.entities) &&
        Array.isArray(data.suggestedActions)
      ) {
        events.push({
          event: "final",
          data: {
            thread_id: data.thread_id,
            message: data.message,
            entities: data.entities,
            suggestedActions: data.suggestedActions,
          },
        });
      }
    } catch {
      // ignore malformed chunks
    }
  }

  return { events, rest };
}

async function* streamAgentAct(params: {
  threadId: string | null;
  message: string;
  churchId: string;
  userId: string;
  personId: string;
}): AsyncGenerator<SseEvent> {
  const res = await fetch("/api/agent/act", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      thread_id: params.threadId,
      message: params.message,
      user_id: params.userId,
      org_id: params.churchId,
      church_id: params.churchId,
      person_id: params.personId,
    }),
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`agent error: ${res.status}${detail ? ` - ${detail}` : ""}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parsed = parseSseChunk(buffer);
    buffer = parsed.rest;
    for (const ev of parsed.events) yield ev;
  }
}

export default function Home() {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [churchId, setChurchId] = useState("calvarybible");
  const [userId, setUserId] = useState("demo_user_noah");
  const [personId, setPersonId] = useState("p_seeker_2");

  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [memoryProfile, setMemoryProfile] = useState<string>("(not loaded)");
  const [lastActions, setLastActions] = useState<string>("[]");

  const [isConnected, setIsConnected] = useState(true);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const calendarAccountAddress = "acct_cust_casey";
  const displayName = "Casey";

  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      content:
        "myclaw is up.\n\nTry: “Find my family by phone …” or “Get my household”.\n\nLocal commands: /mem show | /mem set key=value | /kb add <text> | /kb search <query>",
    },
  ]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [goalText, setGoalText] = useState("");
  const [goalLastOutput, setGoalLastOutput] = useState<string>("");
  const [goalDialogOpen, setGoalDialogOpen] = useState(false);
  const [goalActionContext, setGoalActionContext] = useState("");

  async function loadThreads() {
    const res = await fetch("/api/langgraph/threads?limit=100");
    if (!res.ok) throw new Error(await res.text());
    const data = (await res.json()) as unknown;
    if (!Array.isArray(data)) return;
    const items: ThreadSummary[] = [];
    for (const it of data) {
      if (!isRecord(it) || typeof it.thread_id !== "string") continue;
      items.push({
        thread_id: it.thread_id,
        created_at: typeof it.created_at === "string" ? it.created_at : undefined,
        updated_at: typeof it.updated_at === "string" ? it.updated_at : undefined,
        metadata: it.metadata,
      });
    }
    setThreads(items);
  }

  async function createThread() {
    const res = await fetch("/api/langgraph/threads", { method: "POST" });
    if (!res.ok) throw new Error(await res.text());
    const data = (await res.json()) as unknown;
    const tid = isRecord(data) && typeof data.thread_id === "string" ? data.thread_id : null;
    if (!tid) throw new Error("Failed to create thread");
    setThreadId(tid);
    setMessages([{ role: "assistant", content: "New topic started. What do you want to do?" }]);
    void loadThreads();
  }

  async function loadMemory() {
    const qs = new URLSearchParams({ churchId, userId, personId });
    const res = await fetch(`/api/memory/profile?${qs.toString()}`);
    if (!res.ok) throw new Error(await res.text());
    const text = await res.text();
    setMemoryProfile(text);
  }

  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    scrollRef.current?.scrollIntoView({ block: "end" });
  }, [messages, isStreaming]);

  useEffect(() => {
    void loadThreads().catch(() => {});
  }, []);

  const assistantIndex = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "assistant") return i;
    }
    return -1;
  }, [messages]);

  async function onSend() {
    const text = input.trim();
    if (!text || isStreaming || !isConnected) return;

    setInput("");
    setIsStreaming(true);
    setMessages((m) => [...m, { role: "user", content: text }, { role: "assistant", content: "" }]);

    try {
      for await (const ev of streamAgentAct({ threadId, message: text, churchId, userId, personId })) {
        if (ev.event === "thread") setThreadId(ev.data.thread_id);
        if (ev.event === "delta") {
          setMessages((m) => {
            const idx = (() => {
              for (let i = m.length - 1; i >= 0; i--) if (m[i]?.role === "assistant") return i;
              return -1;
            })();
            if (idx === -1) return m;
            const next = m.slice();
            next[idx] = { role: "assistant", content: (next[idx]?.content ?? "") + ev.data.text };
            return next;
          });
        }
        if (ev.event === "final") {
          setThreadId(ev.data.thread_id);
          setLastActions(JSON.stringify(ev.data.suggestedActions ?? [], null, 2));
          if (ev.data.message) {
            setMessages((m) => {
              const idx = (() => {
                for (let i = m.length - 1; i >= 0; i--) if (m[i]?.role === "assistant") return i;
                return -1;
              })();
              if (idx === -1) return m;
              const next = m.slice();
              if (!(next[idx]?.content ?? "").trim()) {
                next[idx] = { role: "assistant", content: ev.data.message };
              }
              return next;
            });
          }
        }
      }
    } catch (e) {
      const msg = `Error: ${(e as Error).message}`;
      setMessages((m) => {
        const next = m.slice();
        for (let i = next.length - 1; i >= 0; i--) {
          if (next[i]?.role === "assistant") {
            next[i] = { role: "assistant", content: msg };
            return next;
          }
        }
        return [...next, { role: "assistant", content: msg }];
      });
    } finally {
      setIsStreaming(false);
    }
  }

  async function runGoalCommand(cmd: string) {
    const text = cmd.trim();
    if (!text || isStreaming || !isConnected) return;

    setIsStreaming(true);
    setGoalLastOutput("");
    setMessages((m) => [...m, { role: "user", content: text }, { role: "assistant", content: "" }]);

    try {
      for await (const ev of streamAgentAct({ threadId, message: text, churchId, userId, personId })) {
        if (ev.event === "thread") setThreadId(ev.data.thread_id);
        if (ev.event === "delta") {
          setMessages((m) => {
            const idx = (() => {
              for (let i = m.length - 1; i >= 0; i--) if (m[i]?.role === "assistant") return i;
              return -1;
            })();
            if (idx === -1) return m;
            const next = m.slice();
            next[idx] = { role: "assistant", content: (next[idx]?.content ?? "") + ev.data.text };
            return next;
          });
          setGoalLastOutput((t) => t + ev.data.text);
        }
        if (ev.event === "final") {
          setThreadId(ev.data.thread_id);
          setLastActions(JSON.stringify(ev.data.suggestedActions ?? [], null, 2));
          if (ev.data.message) setGoalLastOutput(ev.data.message);
        }
      }
    } catch (e) {
      const msg = `Error: ${(e as Error).message}`;
      setGoalLastOutput(msg);
    } finally {
      setIsStreaming(false);
    }
  }

  function onNewThread() {
    if (isStreaming) return;
    void createThread().catch((e) => {
      setMessages([{ role: "assistant", content: `Error: ${(e as Error).message}` }]);
    });
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-zinc-50 text-zinc-950 dark:bg-black dark:text-zinc-50">
      <header className="sticky top-0 z-10 shrink-0 border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
        <div className="flex w-full items-center justify-between px-4 py-3">
          <div className="flex items-baseline gap-3">
            <div className="text-lg font-semibold tracking-tight">myclaw</div>
            <div className="hidden text-xs text-zinc-500 dark:text-zinc-400 sm:block">
              thread: {threadId ?? "new"}
            </div>
          </div>

          <div className="relative">
            <button
              onClick={() => setUserMenuOpen((v) => !v)}
              className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900"
            >
              <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden />
              <span className="font-medium">{displayName}</span>
              <span className="hidden text-xs text-zinc-500 dark:text-zinc-400 sm:inline">
                {calendarAccountAddress}
              </span>
            </button>

            {userMenuOpen ? (
              <div className="absolute right-0 mt-2 w-64 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
                <div className="px-3 py-2">
                  <div className="text-xs font-semibold">Connected user</div>
                  <div className="mt-1 text-sm">{displayName}</div>
                  <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                    accountAddress: {calendarAccountAddress}
                  </div>
                </div>
                <div className="border-t border-zinc-200 dark:border-zinc-800" />
                <button
                  onClick={() => {
                    setUserMenuOpen(false);
                    setIsConnected(false);
                    setThreadId(null);
                    setMessages([{ role: "assistant", content: "Logged out (mock). Click Connect to continue." }]);
                  }}
                  className="w-full px-3 py-2 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900"
                >
                  Logout
                </button>
                {!isConnected ? (
                  <button
                    onClick={() => {
                      setUserMenuOpen(false);
                      setIsConnected(true);
                    }}
                    className="w-full px-3 py-2 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900"
                  >
                    Connect (mock)
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-4">
        <div className="grid min-h-0 w-full flex-1 grid-cols-1 gap-4 lg:grid-cols-[280px_1fr_320px]">
          <aside className="flex min-h-0 flex-col rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold">Topics</div>
            <button
              onClick={onNewThread}
              className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900"
              disabled={isStreaming}
            >
              New
            </button>
          </div>
          <div className="mt-2 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-1">
            {threads.map((t) => (
              <button
                key={t.thread_id}
                onClick={() => {
                  if (isStreaming) return;
                  setThreadId(t.thread_id);
                  setMessages([{ role: "assistant", content: "Loaded topic. Ask something." }]);
                }}
                className={[
                  "w-full rounded-lg border px-2 py-2 text-left text-xs",
                  t.thread_id === threadId
                    ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-black"
                    : "border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900",
                ].join(" ")}
              >
                <div className="truncate font-medium">{t.thread_id}</div>
                <div className="truncate text-[10px] opacity-70">{t.updated_at ?? t.created_at ?? ""}</div>
              </button>
            ))}
            {!threads.length ? (
              <div className="text-xs text-zinc-500 dark:text-zinc-400">No topics yet.</div>
            ) : null}
          </div>
        </aside>

        <section className="flex min-h-0 flex-col">
          <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <input
              value={churchId}
              onChange={(e) => setChurchId(e.target.value)}
              placeholder="churchId"
              className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
              disabled={isStreaming || !isConnected}
            />
            <input
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="userId"
              className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
              disabled={isStreaming || !isConnected}
            />
            <input
              value={personId}
              onChange={(e) => setPersonId(e.target.value)}
              placeholder="personId"
              className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
              disabled={isStreaming || !isConnected}
            />
          </div>

          <main className="mt-4 flex min-h-0 flex-1 flex-col rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
              {messages.map((m, idx) => (
                <div
                  key={idx}
                  className={[
                    "max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-6",
                    m.role === "user"
                      ? "ml-auto bg-zinc-900 text-white dark:bg-zinc-100 dark:text-black"
                      : "mr-auto bg-zinc-100 text-zinc-950 dark:bg-zinc-900 dark:text-zinc-50",
                  ].join(" ")}
                >
                  {m.content || (isStreaming && idx === assistantIndex ? "…" : "")}
                </div>
              ))}
              <div ref={scrollRef} />
            </div>
          </main>

          <footer className="mt-3 flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void onSend();
              }}
              placeholder="Type a message… (Ctrl/Cmd+Enter to send)"
              className="flex-1 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-zinc-900/10 dark:border-zinc-800 dark:bg-zinc-950 dark:focus:ring-zinc-50/10"
              disabled={isStreaming || !isConnected}
            />
            <button
              onClick={() => void onSend()}
              className="rounded-xl bg-zinc-900 px-4 py-3 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-black dark:hover:bg-white"
              disabled={isStreaming || !input.trim() || !isConnected}
            >
              Send
            </button>
          </footer>
        </section>

        <aside className="flex min-h-0 flex-col overflow-y-auto rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-black">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold">Autonomy</div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setGoalDialogOpen(true)}
                  className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900"
                  disabled={isStreaming || !isConnected}
                  title="Open goal actions dialog"
                >
                  Actions
                </button>
                <button
                  onClick={() => void runGoalCommand("/goal status")}
                  className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900"
                  disabled={isStreaming || !isConnected}
                  title="Show active goal"
                >
                  Status
                </button>
              </div>
            </div>

            <div className="mt-2 flex gap-2">
              <input
                value={goalText}
                onChange={(e) => setGoalText(e.target.value)}
                placeholder="Set an active goal…"
                className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
                disabled={isStreaming || !isConnected}
              />
              <button
                onClick={() => void runGoalCommand(`/goal set ${goalText}`)}
                className="rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-black dark:hover:bg-white"
                disabled={isStreaming || !goalText.trim() || !isConnected}
                title="Set active goal"
              >
                Set
              </button>
            </div>

            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={() => void runGoalCommand("/goal tick")}
                className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900"
                disabled={isStreaming || !isConnected}
                title="Advance the goal (propose next actions)"
              >
                Tick
              </button>
              <div className="text-xs text-zinc-500 dark:text-zinc-400">
                Proposes next actions + updates `goals.active`.
              </div>
            </div>

            {goalLastOutput ? (
              <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-white p-2 text-[11px] text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50">
                {goalLastOutput}
              </pre>
            ) : null}
          </div>

          {goalDialogOpen ? (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
              <div className="w-full max-w-2xl rounded-2xl border border-zinc-200 bg-white p-4 shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold">Goal actions</div>
                  <button
                    onClick={() => setGoalDialogOpen(false)}
                    className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900"
                  >
                    Close
                  </button>
                </div>

                <div className="mt-3">
                  <div className="text-xs font-semibold text-zinc-600 dark:text-zinc-300">Context (optional)</div>
                  <textarea
                    value={goalActionContext}
                    onChange={(e) => setGoalActionContext(e.target.value)}
                    placeholder="Constraints, availability, preferences, contacts to coordinate with, etc."
                    className="mt-1 h-24 w-full resize-none rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
                    disabled={isStreaming || !isConnected}
                  />
                </div>

                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <button
                    onClick={() =>
                      void runGoalCommand(
                        `/goal tick Plan the next 7 days into concrete tasks. If relevant, propose a weekly plan with dates.\n\nContext:\n${goalActionContext}`,
                      )
                    }
                    className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900"
                    disabled={isStreaming || !isConnected}
                    title="Generate a concrete weekly plan"
                  >
                    Plan this week
                  </button>
                  <button
                    onClick={() =>
                      void runGoalCommand(
                        `/goal tick Add the upcoming tasks for the next 7 days to my calendar (create events). Use reasonable default times if not provided.\n\nContext:\n${goalActionContext}`,
                      )
                    }
                    className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900"
                    disabled={isStreaming || !isConnected}
                    title="Create calendar events from the plan"
                  >
                    Add to calendar
                  </button>
                  <button
                    onClick={() =>
                      void runGoalCommand(
                        `/goal tick Coordinate with my trainer/coach (draft a message, ask for missing contact details, and propose the outreach action).\n\nContext:\n${goalActionContext}`,
                      )
                    }
                    className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900"
                    disabled={isStreaming || !isConnected}
                    title="Coordinate with another agent/person"
                  >
                    Coordinate
                  </button>
                  <button
                    onClick={() =>
                      void runGoalCommand(
                        `/goal tick What is the single most important next action I should take today to advance the goal? Keep it concrete.\n\nContext:\n${goalActionContext}`,
                      )
                    }
                    className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900"
                    disabled={isStreaming || !isConnected}
                    title="Get one high-impact next step"
                  >
                    Next action today
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold">Memory</div>
            <button
              onClick={() => void loadMemory().catch(() => {})}
              className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900"
              disabled={isStreaming}
            >
              Refresh
            </button>
          </div>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-zinc-50 p-2 text-[11px] text-zinc-900 dark:bg-black dark:text-zinc-50">
            {memoryProfile}
          </pre>

          <div className="mt-4 text-sm font-semibold">Last actions</div>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-zinc-50 p-2 text-[11px] text-zinc-900 dark:bg-black dark:text-zinc-50">
            {lastActions}
          </pre>
        </aside>
        </div>
      </div>
    </div>
  );
}
