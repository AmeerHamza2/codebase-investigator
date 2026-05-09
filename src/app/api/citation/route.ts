import { NextRequest, NextResponse } from "next/server";
import { readFile } from "@/lib/github";
import { getSession } from "@/lib/memory";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as
    | { sessionId?: string; path?: string; startLine?: number; endLine?: number }
    | null;

  if (!body?.sessionId || !body?.path) {
    return NextResponse.json({ error: "sessionId and path required" }, { status: 400 });
  }
  const session = getSession(body.sessionId);
  if (!session) return NextResponse.json({ error: "Session not found (server may have restarted)" }, { status: 404 });
  if (!session.repo) return NextResponse.json({ error: "Session has no repo" }, { status: 404 });

  // Normalize: extracted citations occasionally have reversed ranges or
  // missing/non-numeric bounds. Coerce to a sane window before reading.
  const rawStart = Number(body.startLine) || 1;
  const rawEnd = Number(body.endLine) || rawStart;
  const lo = Math.max(1, Math.min(rawStart, rawEnd));
  const hi = Math.max(rawStart, rawEnd);
  const start = Math.max(1, lo - 2);
  const end = hi + 2;
  try {
    const f = await readFile(session.repo, body.path, start, end);
    return NextResponse.json({ path: f.path, content: f.content, totalLines: f.totalLines });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
