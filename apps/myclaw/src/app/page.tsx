"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
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
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";

  for (const part of parts) {
    const lines = part.split("\n");
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
}): AsyncGenerator<SseEvent> {
  const res = await fetch("/api/agent/act", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      thread_id: params.threadId,
      message: params.message,
      user_id: "default",
      org_id: "default",
    }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`agent error: ${res.status}`);
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
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      content:
        "myclaw is up. Ask something, or ingest KB via the agent API and then query it.",
    },
  ]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    scrollRef.current?.scrollIntoView({ block: "end" });
  }, [messages, isStreaming]);

  const assistantIndex = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "assistant") return i;
    }
    return -1;
  }, [messages]);

  async function onSend() {
    const text = input.trim();
    if (!text || isStreaming) return;

    setInput("");
    setIsStreaming(true);
    setMessages((m) => [...m, { role: "user", content: text }, { role: "assistant", content: "" }]);

    try {
      for await (const ev of streamAgentAct({ threadId, message: text })) {
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
        }
      }
    } catch (e) {
      setMessages((m) => [
        ...m,
        { role: "assistant", content: `Error: ${(e as Error).message}` },
      ]);
    } finally {
      setIsStreaming(false);
    }
  }

  function onNewThread() {
    if (isStreaming) return;
    setThreadId(null);
    setMessages([
      {
        role: "assistant",
        content: "New thread started. What do you want to do?",
      },
    ]);
  }

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-950 dark:bg-black dark:text-zinc-50">
      <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-4 py-6">
        <header className="flex items-center justify-between gap-4">
          <div className="flex flex-col">
            <div className="text-lg font-semibold tracking-tight">myclaw</div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400">
              thread: {threadId ?? "new"}
            </div>
          </div>
          <button
            onClick={onNewThread}
            className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900"
            disabled={isStreaming}
          >
            New thread
          </button>
        </header>

        <main className="mt-6 flex-1 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex h-[65vh] flex-col gap-3 overflow-y-auto pr-1">
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

        <footer className="mt-4 flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void onSend();
            }}
            placeholder="Type a message… (Ctrl/Cmd+Enter to send)"
            className="flex-1 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-zinc-900/10 dark:border-zinc-800 dark:bg-zinc-950 dark:focus:ring-zinc-50/10"
            disabled={isStreaming}
          />
          <button
            onClick={() => void onSend()}
            className="rounded-xl bg-zinc-900 px-4 py-3 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-black dark:hover:bg-white"
            disabled={isStreaming || !input.trim()}
          >
            Send
          </button>
        </footer>
      </div>
    </div>
  );
}
