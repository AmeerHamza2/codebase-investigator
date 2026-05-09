import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropic, MODEL } from "./anthropic";
import { executeTool, toolDefinitions } from "./tools";
import {
  appendAssistantTurn,
  buildAnthropicHistory,
  extractCitations,
  getClaimHistory,
} from "./memory";
import type { Session, StreamEvent, ToolTraceEntry } from "./types";

const MAX_TOOL_ROUNDS = 12; // 8 wasn't enough for repos like Express where the agent's first hypothesis is wrong
const MAX_TOKENS = 4096; // long "walk me through" answers were getting truncated at 2048
const WRAP_TIMEOUT_MS = 60_000; // a hung wrap call would otherwise freeze the UI indefinitely

// "Inadequate" means the text is so short that the model clearly didn't
// finish answering. We don't check for citations here — a real answer might
// legitimately omit them in some cases, and the audit will downgrade those
// on its own. Overriding any cite-less answer was discarding good content.
const MIN_ADEQUATE_CHARS = 100;
function isInadequateAnswer(text: string): boolean {
  return text.trim().length < MIN_ADEQUATE_CHARS;
}

function systemPrompt(repoLabel: string, claimSummary: string, alreadyRead: string): string {
  return `You are a senior engineer investigating the GitHub repository ${repoLabel}.

You have these tools available:
- list_files(path?) — explore the tree
- read_file(path, start_line?, end_line?) — read code; output is line-numbered
- search_code(query) — substring search (case-insensitive)
- get_file_summary(path) — quick AI summary; prefer read_file for things you'll cite

Workflow:
1. Plan briefly: what files are likely relevant?
2. Use list_files / search_code to locate them.
3. Read the relevant slices with read_file.
4. Reason from what you actually read. Do not guess.
5. Answer the user.

Citation rules (HARD requirements):
- Every non-trivial claim about the code MUST cite a file and line range using the exact format \`path/to/file.ext:START-END\` (or \`path:LINE\` for a single line).
- Only cite line numbers you actually saw in read_file output. Never invent line numbers.
- If you cannot find evidence, say so explicitly — do not fabricate.

Style:
- Be direct. Lead with the answer, then the evidence.
- Skip preamble like "Great question". Skip restating the user's question.
- When the user asks for opinions ("what would you change?"), give a concrete recommendation with a citation that motivates it.

${alreadyRead ? `Files already read in earlier turns (you may cite these without re-reading; re-read only if you need different lines):\n${alreadyRead}\n` : ""}${claimSummary ? `Prior claims in this conversation (do not contradict without acknowledging):\n${claimSummary}\n` : ""}`;
}

function summarizeClaimsForSystem(session: Session): string {
  const claims = getClaimHistory(session);
  if (!claims.length) return "";
  const archAndFix = claims.filter((c) => c.type !== "file_ref").slice(-12);
  if (!archAndFix.length) return "";
  return archAndFix.map((c) => `- [${c.type}] ${c.content}`).join("\n");
}

function summarizeReadFilesForSystem(session: Session): string {
  const seen = new Map<string, { min: number; max: number }>();
  for (const t of session.turns) {
    if (t.role !== "assistant" || !t.toolTrace) continue;
    for (const entry of t.toolTrace) {
      if (entry.tool !== "read_file") continue;
      const path = typeof entry.input.path === "string" ? entry.input.path : null;
      if (!path) continue;
      // Pull the line range from the tool output header (e.g. "src/x.ts (120 lines, showing slice):").
      const m = entry.output.match(/\((\d+) lines/);
      const total = m ? parseInt(m[1], 10) : 0;
      const cur = seen.get(path) ?? { min: 1, max: total };
      cur.max = Math.max(cur.max, total);
      seen.set(path, cur);
    }
  }
  if (!seen.size) return "";
  return Array.from(seen.entries())
    .slice(-20)
    .map(([path, { max }]) => `- ${path}${max ? ` (${max} lines)` : ""}`)
    .join("\n");
}

type ToolUseBlock = Extract<Anthropic.ContentBlock, { type: "tool_use" }>;

export async function* runAgent(
  session: Session,
  userQuery: string,
): AsyncGenerator<StreamEvent, void, unknown> {
  if (!session.repo) {
    yield { type: "error", message: "No repo attached to session" };
    return;
  }
  const client = getAnthropic();
  const repoLabel = `${session.repo.owner}/${session.repo.repo}@${session.repo.ref}`;
  const system = systemPrompt(
    repoLabel,
    summarizeClaimsForSystem(session),
    summarizeReadFilesForSystem(session),
  );

  // History before this turn (the user turn for this query is appended by the caller).
  const messages: Anthropic.MessageParam[] = buildAnthropicHistory(session).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  let finalText = "";
  let hitRoundLimit = false;
  const toolTrace: ToolTraceEntry[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      tools: toolDefinitions,
      messages,
    });

    // Forward text deltas as they come in.
    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        const delta = event.delta.text;
        finalText += delta;
        yield { type: "text_delta", delta };
      }
    }

    const final = await stream.finalMessage();
    const toolUses = final.content.filter((b): b is ToolUseBlock => b.type === "tool_use");

    // Add the assistant message (with any tool_use blocks) to the running history
    messages.push({ role: "assistant", content: final.content });

    if (final.stop_reason !== "tool_use" || toolUses.length === 0) {
      // Done — answer is in finalText (already streamed)
      break;
    }

    // Execute every tool the model called this round, then feed back results.
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      yield { type: "tool_use", tool: tu.name, input: tu.input as Record<string, unknown> };
      const result = await executeTool(session.repo, tu.name, tu.input as Record<string, unknown>);
      const preview = result.output.slice(0, 240).replace(/\s+/g, " ");
      toolTrace.push({
        tool: tu.name,
        input: tu.input as Record<string, unknown>,
        output: result.output.slice(0, 4000),
      });
      yield { type: "tool_result", tool: tu.name, preview };
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: result.output,
        is_error: result.isError || undefined,
      });
    }
    messages.push({ role: "user", content: toolResults });
    // Reset finalText for the next round so we only keep the final assistant text
    finalText = "";
    if (round === MAX_TOOL_ROUNDS - 1) hitRoundLimit = true;
  }

  // If the loop ended with no real answer (empty or only a preamble fragment),
  // force one more no-tools call so the model synthesizes the evidence it
  // gathered. Stream this one too — non-streaming would make the UI appear
  // hung for 30-90s while a long synthesis generates.
  const needWrap = isInadequateAnswer(finalText) && toolTrace.length > 0;
  let wrapAttempted = false;
  let wrapSucceeded = false;
  if (needWrap) {
    wrapAttempted = true;
    const wrapSystem = `You are a senior engineer answering a question about the GitHub repository ${repoLabel}. An investigation has already been done — the findings are summarized below in a fake "assistant" turn. Treat them as ground truth.

CRITICAL — answer NOW based on those findings.

DO NOT:
- Say "I need to see X to fully answer" — refuse to hedge.
- Apologize for incomplete information or ask clarifying questions.
- Summarize what you would investigate next.

DO:
- Lead with a direct answer in the first sentence.
- Cite real line ranges using the format \`path:start-end\` whenever you reference code. The line numbers shown in the findings are the source of truth.
- If a piece of code delegates to an external package (e.g. \`require('router')\`), state that explicitly with a citation — that IS the answer.
- If you can only partially answer, say "I cannot determine X from this repo because Y" with a supporting citation. That is a valid answer.
- Aim for 200+ words. A short answer means you gave up.`;

    // Build a clean wrap conversation from the tool trace. The original
    // `messages` array ends with `user: [tool_results]` and no tools defined,
    // which Sonnet/Haiku sometimes responds to with zero text deltas. A plain
    // Q + findings + Q sequence is unambiguous.
    const findings = toolTrace
      .map((entry, i) => {
        const path = typeof entry.input.path === "string" ? entry.input.path : "";
        const query = typeof entry.input.query === "string" ? entry.input.query : "";
        const label =
          entry.tool === "read_file" ? `read ${path}` :
          entry.tool === "list_files" ? `list ${path || "/"}` :
          entry.tool === "search_code" ? `search "${query}"` :
          entry.tool === "get_file_summary" ? `summary of ${path}` :
          entry.tool;
        return `[${i + 1}] ${label}\n${entry.output.slice(0, 3500)}`;
      })
      .join("\n\n---\n\n");
    const wrapMessages: Anthropic.MessageParam[] = [
      { role: "user", content: userQuery },
      {
        role: "assistant",
        content:
          `Investigation complete. ${toolTrace.length} tool calls. Findings:\n\n${findings}`,
      },
      {
        role: "user",
        content:
          `Using only the findings above, answer my original question now. Cite line ranges as path:start-end. Do not request more files. Lead with the answer.`,
      },
    ];
    let wrapped = "";
    const wrapAbort = new AbortController();
    const wrapTimer = setTimeout(() => wrapAbort.abort(), WRAP_TIMEOUT_MS);
    const wrapStream = client.messages.stream(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: wrapSystem,
        messages: wrapMessages,
      },
      { signal: wrapAbort.signal },
    );
    // If the prior partial answer was preamble, signal a clean restart by
    // emitting a separator so the UI replaces "Now let me trace…" with the
    // synthesized answer instead of appending to it.
    if (finalText) yield { type: "text_delta", delta: "\n\n" };
    try {
      for await (const event of wrapStream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          wrapped += event.delta.text;
          yield { type: "text_delta", delta: event.delta.text };
        }
      }
      await wrapStream.finalMessage();
    } catch (err) {
      const aborted = wrapAbort.signal.aborted;
      const note = aborted
        ? `\n\n[synthesis timed out after ${WRAP_TIMEOUT_MS / 1000}s — partial answer above]`
        : `\n\n[synthesis failed: ${err instanceof Error ? err.message : String(err)}]`;
      wrapped += note;
      yield { type: "text_delta", delta: note };
    } finally {
      clearTimeout(wrapTimer);
    }
    if (wrapped.trim().length >= MIN_ADEQUATE_CHARS) {
      finalText = wrapped.trim();
      wrapSucceeded = true;
    }
  }

  // Fallback only when the agent genuinely failed to answer — either no text
  // at all, or wrap was needed but didn't produce enough. Don't second-guess
  // a substantive answer that just happens to lack a citation; the audit
  // handles that by downgrading the verdict.
  const needFallback = !finalText.trim() || (wrapAttempted && !wrapSucceeded);
  if (needFallback) {
    finalText = toolTrace.length > 0
      ? `I gathered evidence from ${toolTrace.length} tool calls but couldn't produce a synthesized answer. This usually means the model returned an empty completion when forced to answer. Try a narrower question, or set CLAUDE_MODEL=claude-sonnet-4-5 in .env for harder repos.`
      : `I wasn't able to investigate this question. Check the dev server log for upstream errors.`;
    yield { type: "text_delta", delta: "\n\n" + finalText };
  }

  const citations = extractCitations(finalText);
  const turn = appendAssistantTurn(session, finalText, citations, toolTrace);

  yield {
    type: "answer",
    turnIndex: turn.index,
    content: finalText,
    citations,
    claims: turn.claims ?? [],
  };
}
