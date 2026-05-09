import { v4 as uuid } from "uuid";
import type { AuditResult, Citation, Claim, RepoRef, Session, ToolTraceEntry, Turn } from "./types";

// Module-level Map, pinned to globalThis so it survives Next.js dev HMR.
// Without this, every file save re-evaluates the module and wipes sessions —
// citation previews and re-audits then fail with "session not found".
// Persists for the life of the Node.js process; the brief says no DB.
const globalForSessions = globalThis as unknown as { __ci_sessions?: Map<string, Session> };
const sessions: Map<string, Session> = globalForSessions.__ci_sessions ?? new Map();
globalForSessions.__ci_sessions = sessions;

export function createSession(repo: RepoRef): Session {
  const s: Session = { id: uuid(), repo, turns: [], createdAt: Date.now() };
  sessions.set(s.id, s);
  return s;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function getOrCreateSession(id: string | undefined, repo: RepoRef): Session {
  if (id) {
    const existing = sessions.get(id);
    if (existing && existing.repo &&
        existing.repo.owner === repo.owner &&
        existing.repo.repo === repo.repo) {
      // Same repo — refresh the ref (default branch may have moved) and reuse.
      existing.repo = repo;
      return existing;
    }
    // Different repo — fall through and start a fresh session. Reusing the old
    // one would leak prior claims and "files already read" hints across repos
    // and confuse the agent about which codebase it's investigating.
  }
  return createSession(repo);
}

export function appendUserTurn(session: Session, content: string): Turn {
  const turn: Turn = { index: session.turns.length, role: "user", content };
  session.turns.push(turn);
  return turn;
}

export function appendAssistantTurn(
  session: Session,
  content: string,
  citations: Citation[],
  toolTrace: ToolTraceEntry[],
): Turn {
  const claims = extractClaims(session.turns.length, content, citations);
  const turn: Turn = {
    index: session.turns.length,
    role: "assistant",
    content,
    citations,
    claims,
    toolTrace,
  };
  session.turns.push(turn);
  return turn;
}

export function attachAudit(session: Session, turnIndex: number, audit: AuditResult): void {
  const turn = session.turns[turnIndex];
  if (turn) turn.audit = audit;
}

// Citations look like `path/to/file.ts:34-67` or `path/to/file.ts:34`.
// Extension must start with a letter so we don't match version strings like
// `v1.2.3:5` (where `.3` would otherwise look like an extension).
const CITATION_RE = /([\w./@\-+]+\.[a-zA-Z][a-zA-Z0-9]*):(\d+)(?:[-–](\d+))?/g;

export function extractCitations(text: string): Citation[] {
  const out: Citation[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(CITATION_RE)) {
    const path = m[1];
    const start = parseInt(m[2], 10);
    const end = m[3] ? parseInt(m[3], 10) : start;
    const key = `${path}:${start}-${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path, startLine: start, endLine: end });
  }
  return out;
}

// Lightweight claim extraction. Three buckets so the auditor can check for
// contradictions without a heavy NLP pipeline:
//   file_ref       — every cited file/range
//   arch_conclusion — sentences that look like conclusions ("X is …", "Y does …")
//   fix_suggestion  — sentences that propose a change ("you should", "I'd …")
//
// Arch/fix claims are ONLY kept if the same sentence carries a citation —
// otherwise the auditor's "previous claims" history fills with vague hedges
// ("we should think about X") that have no anchor and only add noise.
const CITATION_IN_SENTENCE = /[\w./@\-+]+\.[a-zA-Z][a-zA-Z0-9]*:\d+/;
const MAX_CLAIMS_PER_TYPE = 6;

function extractClaims(turnIndex: number, content: string, citations: Citation[]): Claim[] {
  const claims: Claim[] = [];
  for (const c of citations) {
    claims.push({
      id: uuid(),
      turnIndex,
      type: "file_ref",
      content: `${c.path}:${c.startLine}${c.endLine !== c.startLine ? `-${c.endLine}` : ""}`,
      citations: [c],
    });
  }

  const sentences = content
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 8 && s.length < 400);

  const fixHints = /\b(should|would|could|recommend|suggest|consider|refactor|remove|delete|rename|extract|inline|replace)\b/i;
  const archHints = /\b(handles?|owns?|implements?|delegates?|exposes?|wraps?|guards?|orchestrates?|caches?|persists?|is responsible for|acts? as)\b/i;

  const fix: Claim[] = [];
  const arch: Claim[] = [];
  for (const s of sentences) {
    if (!CITATION_IN_SENTENCE.test(s)) continue;
    if (fixHints.test(s)) {
      fix.push({ id: uuid(), turnIndex, type: "fix_suggestion", content: s, citations: [] });
    } else if (archHints.test(s)) {
      arch.push({ id: uuid(), turnIndex, type: "arch_conclusion", content: s, citations: [] });
    }
  }
  claims.push(...fix.slice(-MAX_CLAIMS_PER_TYPE));
  claims.push(...arch.slice(-MAX_CLAIMS_PER_TYPE));
  return claims;
}

export function getClaimHistory(session: Session, excludeTurnIndex?: number): Claim[] {
  const out: Claim[] = [];
  for (const t of session.turns) {
    if (t.role !== "assistant") continue;
    if (t.index === excludeTurnIndex) continue;
    if (t.claims) out.push(...t.claims);
  }
  return out;
}

// Build the message history Anthropic expects. We trim oversized assistant
// turns by replacing tool-use bodies with summarized tool output, but keep
// every user turn and every final answer. This keeps long sessions intact.
export function buildAnthropicHistory(session: Session): { role: "user" | "assistant"; content: string }[] {
  const history: { role: "user" | "assistant"; content: string }[] = [];
  for (const t of session.turns) {
    if (t.role === "user") {
      history.push({ role: "user", content: t.content });
    } else {
      // For assistant turns we keep the final answer text; tool traces have
      // already done their work in their original turn.
      history.push({ role: "assistant", content: t.content });
    }
  }
  return history;
}
