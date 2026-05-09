"use client";

import { useState } from "react";
import type { Citation, RepoRef } from "@/lib/types";

type Props = {
  repo: RepoRef | null;
  citation: Citation;
};

export function CitationPreview({ repo, citation }: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const label = `${citation.path}:${citation.startLine}${
    citation.endLine !== citation.startLine ? `–${citation.endLine}` : ""
  }`;

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (content || loading) return;
    if (!repo) {
      setError("Repo not connected — re-ask a question to attach this citation.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/citation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repo,
          path: citation.path,
          startLine: citation.startLine,
          endLine: citation.endLine,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setContent(data.content);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="border border-neutral-200 rounded-md overflow-hidden bg-white">
      <button
        onClick={toggle}
        className="w-full px-3 py-1.5 text-left text-xs font-mono flex items-center justify-between hover:bg-neutral-50"
      >
        <span className="truncate">{label}</span>
        <span className="text-neutral-400 ml-2">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="border-t border-neutral-200 bg-neutral-50">
          {loading && <div className="p-2 text-xs text-neutral-500">Loading…</div>}
          {error && <div className="p-2 text-xs text-red-600">{error}</div>}
          {content && (
            <pre className="p-2 text-xs font-mono overflow-x-auto whitespace-pre leading-relaxed">
              {content}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
