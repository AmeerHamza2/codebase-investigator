"use client";

import { FormEvent, useCallback, useRef, useState } from "react";
import { ChatThread, UITurn } from "@/components/ChatThread";
import type { AuditResult, Citation, RepoRef, StreamEvent } from "@/lib/types";

type Status = "idle" | "resolving" | "streaming" | "auditing";

const SAMPLE_QUESTIONS = [
  "How does auth work here, and what would you change about it?",
  "Is there dead code? What's safe to delete?",
  "Walk me through what this service does. Skip the obvious.",
];

export default function Page() {
  const [repoUrl, setRepoUrl] = useState("");
  const [repo, setRepo] = useState<RepoRef | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [turns, setTurns] = useState<UITurn[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const submit = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      if (!repoUrl.trim() || !query.trim() || status !== "idle") return;
      setError(null);

      // If the user changed the repo URL since the last connected repo, drop
      // the old session and chat history. Stale claims from a different repo
      // would otherwise confuse the agent (and stale citations would 404).
      const repoChanged =
        repo !== null &&
        !repoUrl.toLowerCase().includes(`${repo.owner}/${repo.repo}`.toLowerCase());
      const baseTurns = repoChanged ? [] : turns;
      if (repoChanged) {
        setSessionId(null);
        setRepo(null);
      }

      const userTurn: UITurn = { kind: "user", index: baseTurns.length, content: query };
      const assistantIndex = baseTurns.length + 1;
      const assistantTurn: UITurn = {
        kind: "assistant",
        index: assistantIndex,
        content: "",
        citations: [],
        toolEvents: [],
        streaming: true,
      };
      setTurns([...baseTurns, userTurn, assistantTurn]);
      const submittedQuery = query;
      setQuery("");
      setStatus("streaming");

      const ctrl = new AbortController();
      abortRef.current = ctrl;

      try {
        const res = await fetch("/api/investigate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            repoUrl,
            query: submittedQuery,
            sessionId: repoChanged ? undefined : sessionId ?? undefined,
          }),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) {
          const errBody = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 200)}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let textBuf = "";
        let flushTimer: ReturnType<typeof setTimeout> | null = null;

        const flushText = () => {
          if (!textBuf) return;
          const chunk = textBuf;
          textBuf = "";
          setTurns((prev) =>
            prev.map((t) =>
              t.kind === "assistant" && t.index === assistantIndex
                ? { ...t, content: t.content + chunk }
                : t,
            ),
          );
        };

        const scheduleFlush = () => {
          if (flushTimer) return;
          flushTimer = setTimeout(() => {
            flushTimer = null;
            flushText();
          }, 30);
        };

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // Parse SSE frames (data: ...\n\n)
          let nl: number;
          while ((nl = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 2);
            const line = frame.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            const event = JSON.parse(line.slice(6)) as StreamEvent;
            applyEvent(event, assistantIndex, {
              setTurns,
              setSessionId,
              setRepo,
              setStatus,
              setError,
              appendDelta: (d: string) => {
                textBuf += d;
                scheduleFlush();
              },
              flushDelta: flushText,
            });
          }
        }
        flushText();
      } catch (err) {
        const isAbort = err instanceof DOMException && err.name === "AbortError";
        const msg = isAbort ? "Stopped" : err instanceof Error ? err.message : String(err);
        if (!isAbort) setError(msg);
        setTurns((prev) =>
          prev.map((t) =>
            t.kind === "assistant" && t.index === assistantIndex
              ? {
                  ...t,
                  streaming: false,
                  auditPending: false,
                  content: t.content || (isAbort ? "[stopped]" : `[error: ${msg}]`),
                }
              : t,
          ),
        );
      } finally {
        abortRef.current = null;
        setStatus("idle");
      }
    },
    [query, repoUrl, sessionId, status, turns.length],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return (
    <main className="max-w-3xl mx-auto p-6 h-screen flex flex-col">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Codebase Investigator</h1>
        <p className="text-sm text-neutral-600 mt-1">
          Ask questions about any public GitHub repo. Every answer is cited and audited by an
          independent reviewer.
        </p>
      </header>

      <div className="mb-4 bg-white border border-neutral-200 rounded-lg p-3">
        <label className="block text-xs uppercase tracking-wide text-neutral-500 mb-1">
          GitHub repo
        </label>
        <input
          type="text"
          placeholder="https://github.com/owner/repo  or  owner/repo"
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
          className="w-full px-3 py-2 border border-neutral-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-200"
        />
        {repo && (
          <div className="text-xs text-neutral-500 mt-1">
            Connected: <span className="font-mono">{repo.owner}/{repo.repo}@{repo.ref}</span>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto pr-1 mb-4">
        {turns.length === 0 ? (
          <div className="text-sm text-neutral-500 space-y-3">
            <p>Drop in a repo URL above, then ask anything. Try:</p>
            <ul className="space-y-1">
              {SAMPLE_QUESTIONS.map((q) => (
                <li key={q}>
                  <button
                    onClick={() => setQuery(q)}
                    className="text-left text-blue-700 hover:underline"
                  >
                    “{q}”
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <ChatThread sessionId={sessionId ?? ""} turns={turns} />
        )}
      </div>

      {error && (
        <div className="mb-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          {error}
        </div>
      )}

      <form onSubmit={submit} className="flex gap-2 pt-3 border-t border-neutral-200">
        <input
          type="text"
          placeholder={status === "streaming" ? "Investigating…" : "Ask about this repo…"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={status !== "idle"}
          className="flex-1 px-3 py-2 border border-neutral-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:bg-neutral-100"
        />
        {status === "idle" ? (
          <button
            type="submit"
            disabled={!repoUrl.trim() || !query.trim()}
            className="px-4 py-2 bg-neutral-900 text-white rounded-md text-sm font-medium hover:bg-neutral-700 disabled:opacity-40"
          >
            Ask
          </button>
        ) : (
          <button
            type="button"
            onClick={stop}
            className="px-4 py-2 bg-red-600 text-white rounded-md text-sm font-medium hover:bg-red-700"
          >
            Stop
          </button>
        )}
      </form>
    </main>
  );
}

function applyEvent(
  event: StreamEvent,
  assistantIndex: number,
  ctx: {
    setTurns: React.Dispatch<React.SetStateAction<UITurn[]>>;
    setSessionId: (id: string) => void;
    setRepo: (r: RepoRef) => void;
    setStatus: (s: Status) => void;
    setError: (s: string | null) => void;
    appendDelta: (d: string) => void;
    flushDelta: () => void;
  },
) {
  switch (event.type) {
    case "session": {
      ctx.setSessionId(event.sessionId);
      ctx.setRepo(event.repo);
      return;
    }
    case "tool_use": {
      ctx.flushDelta();
      ctx.setTurns((prev) =>
        prev.map((t) =>
          t.kind === "assistant" && t.index === assistantIndex
            ? { ...t, toolEvents: [...(t.toolEvents ?? []), { tool: event.tool, input: event.input }] }
            : t,
        ),
      );
      return;
    }
    case "tool_result": {
      ctx.setTurns((prev) =>
        prev.map((t) => {
          if (t.kind !== "assistant" || t.index !== assistantIndex) return t;
          const events = [...(t.toolEvents ?? [])];
          const last = events.length - 1;
          if (last >= 0 && events[last].tool === event.tool && !events[last].preview) {
            events[last] = { ...events[last], preview: event.preview };
          }
          return { ...t, toolEvents: events };
        }),
      );
      return;
    }
    case "text_delta":
      ctx.appendDelta(event.delta);
      return;
    case "answer": {
      ctx.flushDelta();
      ctx.setTurns((prev) =>
        prev.map((t) =>
          t.kind === "assistant" && t.index === assistantIndex
            ? {
                ...t,
                content: event.content,
                citations: event.citations,
                streaming: false,
                auditPending: true,
              }
            : t,
        ),
      );
      ctx.setStatus("auditing");
      return;
    }
    case "audit": {
      ctx.setTurns((prev) =>
        prev.map((t) =>
          t.kind === "assistant" && t.index === assistantIndex
            ? { ...t, audit: event.result as AuditResult, auditPending: false }
            : t,
        ),
      );
      return;
    }
    case "error": {
      ctx.setError(event.message);
      ctx.setTurns((prev) =>
        prev.map((t) =>
          t.kind === "assistant" && t.index === assistantIndex
            ? { ...t, streaming: false, auditPending: false }
            : t,
        ),
      );
      return;
    }
    case "done": {
      // Defensive: if the stream closed without an audit event, clear the
      // pending spinner so the UI doesn't get stuck on "Auditing…".
      ctx.setTurns((prev) =>
        prev.map((t) =>
          t.kind === "assistant" && t.index === assistantIndex && t.auditPending
            ? { ...t, auditPending: false }
            : t,
        ),
      );
      return;
    }
  }
}

// Avoid unused-import warning when Citation type changes shape later
export type { Citation };
