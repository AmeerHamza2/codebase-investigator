export type RepoRef = {
  owner: string;
  repo: string;
  ref: string; // branch or commit sha
};

export type Citation = {
  path: string;
  startLine: number;
  endLine: number;
  snippet?: string;
};

export type Claim = {
  id: string;
  turnIndex: number;
  type: "file_ref" | "arch_conclusion" | "fix_suggestion";
  content: string;
  citations: Citation[];
};

export type AuditVerdict = "trust" | "verify" | "reject";

export type AuditResult = {
  trust_score: 1 | 2 | 3 | 4 | 5;
  issues: string[];
  // Direct contradictions with prior assistant claims, surfaced separately so
  // the UI can highlight them — the brief asks for explicit surfacing.
  contradictions: string[];
  verdict: AuditVerdict;
  summary: string;
};

export type Turn = {
  index: number;
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  claims?: Claim[];
  audit?: AuditResult;
  // Raw tool-use trace for debugging / future audit context
  toolTrace?: ToolTraceEntry[];
};

export type ToolTraceEntry = {
  tool: string;
  input: Record<string, unknown>;
  output: string; // truncated/summarized for memory
};

export type Session = {
  id: string;
  repo: RepoRef | null;
  turns: Turn[];
  createdAt: number;
};

export type StreamEvent =
  | { type: "session"; sessionId: string; repo: RepoRef }
  | { type: "tool_use"; tool: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool: string; preview: string }
  | { type: "text_delta"; delta: string }
  | { type: "answer"; turnIndex: number; content: string; citations: Citation[]; claims: Claim[] }
  | { type: "audit"; turnIndex: number; result: AuditResult }
  | { type: "error"; message: string }
  | { type: "done" };
