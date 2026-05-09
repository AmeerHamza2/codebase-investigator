import { NextRequest } from "next/server";
import { runAgent } from "@/lib/agent";
import { friendlyAnthropicError } from "@/lib/anthropic";
import { auditAnswer } from "@/lib/auditor";
import { resolveRepo } from "@/lib/github";
import { appendUserTurn, attachAudit, getOrCreateSession } from "@/lib/memory";
import type { StreamEvent } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sse(event: StreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as
    | { repoUrl?: string; query?: string; sessionId?: string }
    | null;

  if (!body?.repoUrl || !body?.query) {
    return new Response(JSON.stringify({ error: "repoUrl and query are required" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: StreamEvent) => controller.enqueue(encoder.encode(sse(e)));
      try {
        const repo = await resolveRepo(body.repoUrl!);
        const session = getOrCreateSession(body.sessionId, repo);
        send({ type: "session", sessionId: session.id, repo });

        appendUserTurn(session, body.query!);

        let answerTurnIndex = -1;
        let answerText = "";
        let answerCitations: { path: string; startLine: number; endLine: number }[] = [];

        for await (const event of runAgent(session, body.query!)) {
          send(event);
          if (event.type === "answer") {
            answerTurnIndex = event.turnIndex;
            answerText = event.content;
            answerCitations = event.citations;
          }
        }

        if (answerTurnIndex >= 0) {
          try {
            const audit = answerText
              ? await auditAnswer(session, answerTurnIndex, answerText, answerCitations)
              : ({
                  trust_score: 1 as const,
                  issues: ["Agent produced no answer to audit."],
                  contradictions: [],
                  verdict: "reject" as const,
                  summary: "No answer was generated; nothing to verify.",
                });
            attachAudit(session, answerTurnIndex, audit);
            send({ type: "audit", turnIndex: answerTurnIndex, result: audit });
          } catch (err) {
            // auditAnswer now catches its own errors and returns a verdict,
            // but a thrown excerpt-fetch error or similar still ends up here.
            const msg = friendlyAnthropicError(err);
            send({
              type: "audit",
              turnIndex: answerTurnIndex,
              result: {
                trust_score: 2,
                issues: [`Audit pipeline error: ${msg}`],
                contradictions: [],
                verdict: "verify",
                summary: "Audit could not run — answer is unverified.",
              },
            });
          }
        }

        send({ type: "done" });
      } catch (err) {
        send({ type: "error", message: friendlyAnthropicError(err) });
        send({ type: "done" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
