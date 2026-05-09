"use client";

import type { AuditResult } from "@/lib/types";

type Props = {
  audit?: AuditResult;
  pending?: boolean;
};

const VERDICT_STYLES: Record<AuditResult["verdict"], { bg: string; border: string; text: string; label: string }> = {
  trust: {
    bg: "bg-green-50",
    border: "border-green-300",
    text: "text-green-800",
    label: "TRUST",
  },
  verify: {
    bg: "bg-yellow-50",
    border: "border-yellow-300",
    text: "text-yellow-800",
    label: "VERIFY",
  },
  reject: {
    bg: "bg-red-50",
    border: "border-red-300",
    text: "text-red-800",
    label: "REJECT",
  },
};

export function AuditPanel({ audit, pending }: Props) {
  if (pending) {
    return (
      <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-500">
        Auditing…
      </div>
    );
  }
  if (!audit) return null;

  const style = VERDICT_STYLES[audit.verdict];
  return (
    <div className={`rounded-md border ${style.border} ${style.bg} px-3 py-2 text-xs`}>
      <div className="flex items-center gap-2 mb-1">
        <span className={`font-semibold tracking-wide ${style.text}`}>{style.label}</span>
        <span className="text-neutral-400">·</span>
        <span className="text-neutral-700">trust score {audit.trust_score}/5</span>
      </div>
      <div className="text-neutral-800">{audit.summary}</div>
      {audit.contradictions.length > 0 && (
        <div className="mt-2 rounded border border-orange-300 bg-orange-50 px-2 py-1.5">
          <div className="text-[0.7rem] font-semibold uppercase tracking-wide text-orange-800">
            Contradicts earlier turn
          </div>
          <ul className="mt-1 list-disc list-inside space-y-0.5 text-orange-900">
            {audit.contradictions.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      {audit.issues.length > 0 && (
        <ul className="mt-2 list-disc list-inside space-y-0.5 text-neutral-700">
          {audit.issues.map((issue, i) => (
            <li key={i}>{issue}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
