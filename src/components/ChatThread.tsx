"use client";

import { useEffect, useRef } from "react";
import type { AuditResult, Citation } from "@/lib/types";
import { AnswerCard } from "./AnswerCard";

export type ToolEvent = {
  tool: string;
  input?: Record<string, unknown>;
  preview?: string;
};

export type UITurn =
  | { kind: "user"; index: number; content: string }
  | {
      kind: "assistant";
      index: number;
      content: string;
      citations: Citation[];
      audit?: AuditResult;
      auditPending?: boolean;
      toolEvents?: ToolEvent[];
      streaming?: boolean;
    };

type Props = {
  sessionId: string;
  turns: UITurn[];
};

export function ChatThread({ sessionId, turns }: Props) {
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  return (
    <div className="space-y-4">
      {turns.map((t) =>
        t.kind === "user" ? (
          <div key={`u-${t.index}`} className="flex justify-end">
            <div className="max-w-[80%] bg-neutral-900 text-white rounded-lg px-4 py-2 text-sm whitespace-pre-wrap">
              {t.content}
            </div>
          </div>
        ) : (
          <div key={`a-${t.index}`}>
            <AnswerCard
              sessionId={sessionId}
              content={t.content}
              citations={t.citations}
              audit={t.audit}
              auditPending={t.auditPending}
              toolEvents={t.toolEvents}
              streaming={t.streaming}
            />
          </div>
        ),
      )}
      <div ref={endRef} />
    </div>
  );
}
