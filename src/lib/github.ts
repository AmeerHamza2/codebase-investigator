import type { RepoRef } from "./types";

const GITHUB_API = "https://api.github.com";

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "codebase-investigator",
  };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

// Translate a raw GitHub HTTP failure into a message a user can act on.
// We surface this directly in the UI's error banner, so it shouldn't sound
// like a stack trace.
function friendlyGitHubError(status: number, path: string, body: string): string {
  const repoMatch = path.match(/^\/repos\/([^/?]+)\/([^/?]+)/);
  const repoLabel = repoMatch ? `${repoMatch[1]}/${repoMatch[2]}` : "GitHub";
  const hasToken = !!process.env.GITHUB_TOKEN;
  // Distinguish "repo doesn't exist" from "file doesn't exist within the repo".
  // The /contents/<path> endpoint returns 404 for missing files too, so a
  // generic "Repository not found" message would lie about what failed.
  const isFileLookup = /\/contents\//.test(path) || /\/git\/trees\//.test(path);

  if (status === 404) {
    if (isFileLookup) {
      const fileMatch = path.match(/\/contents\/([^?]+)/);
      const filePath = fileMatch ? decodeURI(fileMatch[1]) : "(unknown path)";
      return `File not found in ${repoLabel}: "${filePath}". The path may be misspelled or moved — check the actual file location on github.com.`;
    }
    return `Repository not found: ${repoLabel}. Double-check the URL — the repo may be misspelled, private, or moved. Try searching for it on github.com first.`;
  }
  if (status === 401) {
    return `GitHub authentication failed. The GITHUB_TOKEN in .env is invalid or expired — generate a fresh token at https://github.com/settings/tokens (scope: public_repo) and restart the dev server.`;
  }
  if (status === 403) {
    if (/rate limit/i.test(body)) {
      return hasToken
        ? `GitHub rate limit reached even with auth (5000/hr). Wait roughly an hour, or use a different token.`
        : `GitHub rate limit reached (60/hr for unauthenticated requests). Add GITHUB_TOKEN to .env and restart to bump it to 5000/hr.`;
    }
    return `GitHub denied access to ${repoLabel} (403). Your token may lack the required permission, or the repo's API access is restricted.`;
  }
  if (status === 422) {
    return `GitHub rejected the request as invalid (422). The path or query was malformed: ${path}.`;
  }
  if (status >= 500) {
    return `GitHub is having issues right now (HTTP ${status}). Try again in a moment.`;
  }
  return `GitHub returned ${status} for ${repoLabel}: ${body.slice(0, 160)}`;
}

async function gh<T>(path: string): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(friendlyGitHubError(res.status, path, body));
  }
  return (await res.json()) as T;
}

export function parseRepoUrl(input: string): { owner: string; repo: string } {
  const trimmed = input.trim().replace(/\.git$/, "");
  // Accept https://github.com/o/r, github.com/o/r, or o/r
  const m = trimmed.match(/(?:github\.com\/)?([^/\s]+)\/([^/\s?#]+)/i);
  if (!m) {
    throw new Error(
      `Couldn't read that as a GitHub repo. Try one of: "owner/repo", "github.com/owner/repo", or "https://github.com/owner/repo".`,
    );
  }
  return { owner: m[1], repo: m[2] };
}

export async function resolveRepo(input: string): Promise<RepoRef> {
  const { owner, repo } = parseRepoUrl(input);
  const meta = await gh<{ default_branch: string }>(`/repos/${owner}/${repo}`);
  return { owner, repo, ref: meta.default_branch };
}

type TreeEntry = {
  path: string;
  type: "blob" | "tree" | "commit";
  size?: number;
  sha: string;
};

let treeCache = new Map<string, TreeEntry[]>();

export async function getTree(repo: RepoRef): Promise<TreeEntry[]> {
  const key = `${repo.owner}/${repo.repo}@${repo.ref}`;
  const cached = treeCache.get(key);
  if (cached) return cached;
  const data = await gh<{ tree: TreeEntry[]; truncated: boolean }>(
    `/repos/${repo.owner}/${repo.repo}/git/trees/${repo.ref}?recursive=1`,
  );
  treeCache.set(key, data.tree);
  return data.tree;
}

export async function listFiles(repo: RepoRef, dirPath = ""): Promise<string[]> {
  const tree = await getTree(repo);
  const norm = dirPath.replace(/^\/+|\/+$/g, "");
  const prefix = norm ? norm + "/" : "";
  const out = new Set<string>();
  for (const e of tree) {
    if (norm && !e.path.startsWith(prefix)) continue;
    const rel = norm ? e.path.slice(prefix.length) : e.path;
    if (!rel) continue;
    // Show only direct children to keep listings tractable
    const slash = rel.indexOf("/");
    if (slash === -1) {
      out.add(e.type === "tree" ? rel + "/" : rel);
    } else {
      out.add(rel.slice(0, slash) + "/");
    }
  }
  return Array.from(out).sort();
}

const MAX_FILE_BYTES = 200_000; // skip very large files
const MAX_RETURN_LINES = 600; // cap response size when no slice given

export async function readFile(
  repo: RepoRef,
  path: string,
  startLine?: number,
  endLine?: number,
): Promise<{ path: string; content: string; totalLines: number; sliced: boolean }> {
  const cleaned = path.replace(/^\/+/, "");
  const url = `/repos/${repo.owner}/${repo.repo}/contents/${encodeURI(cleaned)}?ref=${encodeURIComponent(repo.ref)}`;
  const data = await gh<{ content?: string; encoding?: string; size?: number; type?: string }>(url);
  if (data.type !== "file" || !data.content) {
    throw new Error(`Not a file: ${path}`);
  }
  if ((data.size ?? 0) > MAX_FILE_BYTES) {
    throw new Error(`File too large (${data.size} bytes): ${path}`);
  }
  const buf = Buffer.from(data.content, (data.encoding as BufferEncoding) || "base64");
  const text = buf.toString("utf8");
  const lines = text.split(/\r?\n/);
  const total = lines.length;

  let sliced = false;
  let s = 1;
  let e = total;
  if (startLine || endLine) {
    sliced = true;
    s = Math.max(1, startLine ?? 1);
    e = Math.min(total, endLine ?? total);
  } else if (total > MAX_RETURN_LINES) {
    sliced = true;
    e = MAX_RETURN_LINES;
  }
  const slice = lines.slice(s - 1, e);
  // Render with line numbers for the model
  const numbered = slice
    .map((line, i) => `${String(s + i).padStart(5, " ")}  ${line}`)
    .join("\n");
  return { path: cleaned, content: numbered, totalLines: total, sliced };
}

export type SearchHit = { path: string; line: number; snippet: string };

const TEXT_EXTS = /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|bash|zsh|sql|yaml|yml|toml|json|md|mdx|html|css|scss|vue|svelte|lua|tf)$/i;
const SEARCH_FILE_LIMIT = 60; // cap fallback grep
const SEARCH_RESULT_LIMIT = 25;

export async function searchCode(repo: RepoRef, query: string): Promise<SearchHit[]> {
  const q = query.trim();
  if (!q) return [];

  // Prefer GitHub Code Search when a token is available (auth required).
  if (process.env.GITHUB_TOKEN) {
    try {
      const url = `/search/code?q=${encodeURIComponent(`${q} repo:${repo.owner}/${repo.repo}`)}&per_page=${SEARCH_RESULT_LIMIT}`;
      const data = await gh<{
        items: { path: string; text_matches?: { fragment: string }[] }[];
      }>(url);
      const items = data.items ?? [];
      const hits: SearchHit[] = [];
      for (const item of items) {
        // Search API doesn't return line numbers; locate first occurrence in file.
        try {
          const f = await readFile(repo, item.path);
          const idx = f.content.split("\n").findIndex((l) => l.toLowerCase().includes(q.toLowerCase()));
          if (idx >= 0) {
            const lineMatch = f.content.split("\n")[idx].match(/^\s*(\d+)/);
            const line = lineMatch ? parseInt(lineMatch[1], 10) : idx + 1;
            const snippet = f.content.split("\n")[idx].replace(/^\s*\d+\s\s/, "").trim();
            hits.push({ path: item.path, line, snippet: snippet.slice(0, 200) });
          }
        } catch {
          // skip unreadable files
        }
        if (hits.length >= SEARCH_RESULT_LIMIT) break;
      }
      // Only fall back to grep if the API itself failed. If it returned a
      // (possibly empty) result set, trust it — re-grepping wastes time.
      return hits;
    } catch {
      // fall through to grep fallback (network / auth / index error)
    }
  }

  // Fallback: grep through a bounded set of text files in the tree.
  const tree = await getTree(repo);
  const candidates = tree
    .filter((e) => e.type === "blob" && TEXT_EXTS.test(e.path) && (e.size ?? 0) < MAX_FILE_BYTES)
    .slice(0, SEARCH_FILE_LIMIT);
  const needle = q.toLowerCase();
  const hits: SearchHit[] = [];
  for (const entry of candidates) {
    try {
      const f = await readFile(repo, entry.path);
      const lines = f.content.split("\n");
      for (const raw of lines) {
        const m = raw.match(/^\s*(\d+)\s\s(.*)$/);
        if (!m) continue;
        if (m[2].toLowerCase().includes(needle)) {
          hits.push({
            path: entry.path,
            line: parseInt(m[1], 10),
            snippet: m[2].slice(0, 200),
          });
          if (hits.length >= SEARCH_RESULT_LIMIT) return hits;
          break; // one hit per file is enough for a grep summary
        }
      }
    } catch {
      // skip
    }
  }
  return hits;
}
