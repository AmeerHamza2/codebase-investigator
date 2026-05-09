# Codebase Investigator

Paste a public GitHub repo URL, ask questions in plain English, and get answers grounded in real files and line numbers — with an **independent audit** for every answer.

## What it does

- **Tool-use agent**: Claude drives a multi-step investigation using `list_files`, `read_file`, `search_code`, and `get_file_summary`. It explores the repo, reads slices, reasons, reads more, and answers. Tool budget is bounded (12 rounds); if exhausted, a no-tools synthesis call is forced so the user always gets an answer.
- **Hard citations**: Every non-trivial claim cites `path/to/file.ts:34-67`. Citations are clickable badges that lazy-load the actual numbered source from GitHub.
- **Independent auditor**: After each answer, a *separate* API call (different system prompt, different context — only the answer + the cited file excerpts + previous claims) returns a structured verdict: `trust_score` (1–5), `issues[]`, `contradictions[]`, `verdict` (`trust` / `verify` / `reject`), and a one-line summary. Negative-existence claims ("X is dead code", "Y is never called") are automatically downgraded to `verify` because they can't be proven from line excerpts alone.
- **Multi-turn memory**: Full conversation history persists across turns within a session. Prior architectural conclusions and fix suggestions are surfaced to the auditor so it can flag contradictions, which render as a separate orange callout in the UI. Files already read are also surfaced to the agent so it doesn't re-read them.
- **Streaming UI**: Server-Sent Events stream tool calls, text deltas, the final answer, and the audit verdict. A Stop button cancels mid-investigation. Switching repos starts a fresh session automatically.

## Quick start

```bash
cd codebase-investigator
cp .env.example .env
# edit .env and set ANTHROPIC_API_KEY
npm install
npm run dev
```

Open http://localhost:3000.

## Environment

- `ANTHROPIC_API_KEY` — required. Used for both the agent and the auditor (separate API calls).
- `GITHUB_TOKEN` — optional. Without it, the GitHub API limits you to 60 requests/hour and code search is disabled (the tool falls back to grepping a bounded set of files in the tree). With a token, you get 5000 requests/hour and real code search. Only `public_repo` scope is needed.
- `CLAUDE_MODEL` — optional. Defaults to `claude-haiku-4-5`. Override with a stronger model (e.g. `claude-sonnet-4-5`) for harder questions; Haiku is fast and cheap and adequate for most repo Q&A.

## Architecture

```
src/
├── app/
│   ├── page.tsx                   ← chat UI (client component)
│   ├── layout.tsx                 ← root layout
│   ├── globals.css                ← Tailwind entry
│   └── api/
│       ├── investigate/route.ts   ← streams agent + audit (SSE)
│       └── citation/route.ts      ← on-demand file slice for previews
├── lib/
│   ├── types.ts                   ← shared types
│   ├── anthropic.ts               ← SDK client + model id
│   ├── github.ts                  ← file tree, read, search (with grep fallback)
│   ├── tools.ts                   ← tool definitions + executors
│   ├── agent.ts                   ← multi-step tool-use loop, async generator
│   ├── auditor.ts                 ← isolated audit pass, JSON-only verdict
│   └── memory.ts                  ← in-memory sessions + claim extraction
└── components/
    ├── ChatThread.tsx
    ├── AnswerCard.tsx
    ├── AuditPanel.tsx             ← color-coded trust / verify / reject
    └── CitationPreview.tsx        ← lazy-loaded line ranges
```

## How the audit guarantees independence

The auditor never sees the agent's internal reasoning, tool trace, or system prompt. It receives only:

1. The final answer text.
2. The actual lines of every cited file range, fetched fresh from GitHub (with a few lines of context around each). File content is escaped before splicing into the prompt so a malicious repo can't break out of the `<files>` section.
3. A flat list of prior architectural conclusions and fix suggestions from earlier turns.

It returns *only* JSON, parsed defensively. Edge cases handled:

- Malformed JSON → falls back to `verdict: "verify"` with an explanatory issue.
- Audit call hangs longer than 45 seconds → aborts and surfaces a `verify` verdict explaining the timeout.
- Empty agent answer → emits a synthetic `reject` verdict instead of leaving the UI on a forever spinner.

Same model as the agent — but a fresh API call with isolated context. The auditor's system prompt is also distinct: it explicitly enumerates positive vs. negative claim types and instructs the model to be skeptical of "X is unused" / "this is the only place" / "no other file does Y" assertions.

## Memory model

Each session keeps:

- The full ordered list of turns (user + assistant).
- For every assistant turn: the answer text, extracted citations, claims (`file_ref`, `arch_conclusion`, `fix_suggestion`), the audit result, and the tool trace.

When a new turn starts, the agent's system prompt includes a recent slice of prior architectural and fix claims (so it stays consistent) plus a list of files it has already read in earlier turns (so it doesn't waste tool calls re-reading them). The auditor receives the full claim history excluding the turn being audited, so contradictions surface only when there's a real disagreement.

Arch/fix claims are only retained when the same sentence carries a citation — vague hedges without anchors are filtered out so the auditor's claim history stays signal-rich.

Sessions live in a `Map` pinned to `globalThis` so they survive Next.js HMR in dev. They do **not** survive a server restart — the brief explicitly waived persistent storage. When the user pastes a different repo URL, the session resets automatically.

## Known limitations

- **In-memory state**: server restarts wipe sessions. Per the brief's "What to Cut" list (no DB).
- **Tree truncation**: GitHub truncates the recursive tree response for very large repos (~100k files). The tool degrades gracefully but search only sees what's in the truncated tree.
- **Search fallback**: without `GITHUB_TOKEN`, search greps through the first 60 text files. Adequate for small/medium repos; bigger repos benefit from a token (which also lifts the 60 req/hr GitHub rate limit to 5000/hr).
- **Citation extraction**: parsed via regex (`path.ext:line[-line]`) requiring an alphabetic-starting extension so version strings like `v1.2.3:5` aren't false-positively cited. The agent is heavily prompted to use this exact format; rare malformed citations still slip through.
- **Model on big repos**: `claude-haiku-4-5` (the default) sometimes fails to synthesize after 12+ tool calls of accumulated context. The system detects this and forces a clean wrap-call with the investigation summary as input — but if that also fails, a fallback message tells the user to try a narrower question or set `CLAUDE_MODEL=claude-sonnet-4-5`.
- **Audit can't fact-check language semantics**: the auditor verifies citations against fresh file content and flags negative-existence claims, but it doesn't fact-check general-knowledge claims about a language ("ES6 classes can't be made callable" is technically wrong but the auditor doesn't catch it because it's not a claim about the cited code). By design — the brief asks for grounding, not omniscience.
- **Audit cost**: every answer triggers a second Claude call. Acceptable for an investigation tool; not free.
- **Timeouts**: wrap-call synthesis is bounded at 60s, audit at 45s. Either timing out surfaces a clear message in the UI rather than freezing.

## Sample questions

The brief's example mix — retrieval, evaluation, opinion — all work:

- "How does auth work here, and what would you change about it?"
- "Is there dead code? What's safe to delete?" *(audit-stress: should land on `verify`, not `trust`, because negative claims aren't excerpt-verifiable)*
- "Why is this function async? Does it need to be?"
- "Walk me through what this service does. Skip the obvious."
- "In your last answer you said X — show me the exact line and tell me what would break if we changed it." *(multi-turn pushback)*

## Type-check & build

```bash
npm run typecheck
npm run build
```

## What was cut

Per the brief's "What to Cut" list, deliberately omitted:

- No auth / user accounts
- No vector DB or embeddings (direct file reading via tool use)
- No rate limit handling beyond surfacing GitHub's response with a friendly message
- No mobile optimization or dark mode
- No persistent storage — sessions are in-memory by spec
- No tests beyond `tsc --noEmit` — manual verification scenarios are documented in the README

What I'd add next if this were going to production: persistent sessions in Redis, per-IP rate limiting on `/api/investigate`, auth on the audit endpoint, and a small unit-test suite around the citation regex and audit JSON parser.
