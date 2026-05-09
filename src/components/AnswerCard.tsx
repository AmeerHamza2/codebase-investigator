"use client";

import { useMemo } from "react";
import type { AuditResult, Citation } from "@/lib/types";
import { AuditPanel } from "./AuditPanel";
import { CitationPreview } from "./CitationPreview";

type ToolEvent = {
  tool: string;
  input?: Record<string, unknown>;
  preview?: string;
};

type Props = {
  sessionId: string;
  content: string;
  citations: Citation[];
  audit?: AuditResult;
  auditPending?: boolean;
  toolEvents?: ToolEvent[];
  streaming?: boolean;
};

// Render the answer text, turning inline citations like `path/file.ts:34-67`
// into clickable monospace badges that scroll to / open the matching preview below.
function renderContentWithCitationLinks(content: string): React.ReactNode[] {
  const re = /([\w./@\-+]+\.[a-zA-Z][a-zA-Z0-9]*):(\d+)(?:[-–](\d+))?/g;
  const out: React.ReactNode[] = [];
  let lastIdx = 0;
  let i = 0;
  for (const m of content.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > lastIdx) out.push(content.slice(lastIdx, idx));
    out.push(
      <code
        key={`c-${i++}`}
        className="px-1 py-0.5 rounded bg-blue-50 text-blue-700 text-[0.85em] font-mono"
      >
        {m[0]}
      </code>,
    );
    lastIdx = idx + m[0].length;
  }
  if (lastIdx < content.length) out.push(content.slice(lastIdx));
  return out;
}

export function AnswerCard({
  sessionId,
  content,
  citations,
  audit,
  auditPending,
  toolEvents,
  streaming,
}: Props) {
  const dedupedCitations = useMemo(() => {
    const seen = new Set<string>();
    return citations.filter((c) => {
      const k = `${c.path}:${c.startLine}-${c.endLine}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [citations]);

  const paragraphs = content.split(/\n\n+/);

  return (
    <div className="bg-white border border-neutral-200 rounded-lg p-4 space-y-3">
      <div className="prose prose-sm max-w-none text-neutral-900 leading-relaxed whitespace-pre-wrap">
        {paragraphs.map((p, i) => (
          <p key={i} className="m-0 mb-2 last:mb-0">
            {renderContentWithCitationLinks(p)}
          </p>
        ))}
        {streaming && <span className="inline-block w-2 h-4 bg-neutral-400 animate-pulse align-middle ml-1" />}
      </div>

      {toolEvents && toolEvents.length > 0 && (
        <details className="text-xs text-neutral-500">
          <summary className="cursor-pointer hover:text-neutral-800">
            Tool trace ({toolEvents.length})
          </summary>
          <ul className="mt-1 space-y-0.5 font-mono">
            {toolEvents.map((t, i) => (
              <li key={i} className="truncate">
                <span className="text-neutral-700">{t.tool}</span>
                {t.input && (
                  <span className="text-neutral-500"> {JSON.stringify(t.input)}</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {dedupedCitations.length > 0 && (
        <div className="space-y-1">
          <div className="text-xs uppercase tracking-wide text-neutral-500">Citations</div>
          <div className="space-y-1">
            {dedupedCitations.map((c, i) => (
              <CitationPreview key={i} sessionId={sessionId} citation={c} />
            ))}
          </div>
        </div>
      )}

      <AuditPanel audit={audit} pending={auditPending && !audit} />
    </div>
  );
}
