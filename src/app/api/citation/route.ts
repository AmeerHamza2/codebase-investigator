import { NextRequest, NextResponse } from "next/server";
import { readFile } from "@/lib/github";
import type { RepoRef } from "@/lib/types";

export const runtime = "nodejs";

// Citation previews are stateless on purpose. Looking up the repo via session
// breaks on Vercel because serverless invocations don't share the in-memory
// Map — the request that creates the session may land on a different instance
// than the request that fetches the citation. The client already knows the
// repo, so it sends it directly.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as
    | {
        repo?: RepoRef;
        path?: string;
        startLine?: number;
        endLine?: number;
      }
    | null;

  if (!body?.repo?.owner || !body?.repo?.repo || !body?.repo?.ref) {
    return NextResponse.json(
      { error: "repo { owner, repo, ref } is required" },
      { status: 400 },
    );
  }
  if (!body?.path) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }

  // Normalize: extracted citations occasionally have reversed ranges or
  // missing/non-numeric bounds. Coerce to a sane window before reading.
  const rawStart = Number(body.startLine) || 1;
  const rawEnd = Number(body.endLine) || rawStart;
  const lo = Math.max(1, Math.min(rawStart, rawEnd));
  const hi = Math.max(rawStart, rawEnd);
  const start = Math.max(1, lo - 2);
  const end = hi + 2;
  try {
    const f = await readFile(body.repo, body.path, start, end);
    return NextResponse.json({ path: f.path, content: f.content, totalLines: f.totalLines });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
