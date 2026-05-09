import type Anthropic from "@anthropic-ai/sdk";
import { listFiles, readFile, searchCode } from "./github";
import { getAnthropic, MODEL } from "./anthropic";
import type { RepoRef } from "./types";

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: "list_files",
    description:
      "List files and directories under a path (or repo root if omitted). Directories end with '/'. Use this first to map the repo, then drill in.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo-relative directory path. Empty for root." },
      },
    },
  },
  {
    name: "read_file",
    description:
      "Read a file (or a line range slice). Lines are 1-indexed. Returns numbered lines. Always cite line numbers from the output. Files larger than 600 lines are truncated unless you pass start_line/end_line.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo-relative file path" },
        start_line: { type: "integer", minimum: 1 },
        end_line: { type: "integer", minimum: 1 },
      },
      required: ["path"],
    },
  },
  {
    name: "search_code",
    description:
      "Substring search across the repo's text files. Returns up to 25 hits with path/line/snippet. Use it to locate symbols, imports, or call sites. Case-insensitive.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring to search for" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_file_summary",
    description:
      "Quick AI-generated summary of a file's purpose and structure. Use sparingly — prefer read_file when you need actual code to cite.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo-relative file path" },
      },
      required: ["path"],
    },
  },
];

const summaryCache = new Map<string, string>();

async function summarizeFile(repo: RepoRef, path: string): Promise<string> {
  const key = `${repo.owner}/${repo.repo}@${repo.ref}:${path}`;
  const cached = summaryCache.get(key);
  if (cached) return cached;
  const file = await readFile(repo, path);
  const client = getAnthropic();
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 400,
    system:
      "You summarize source files for an engineer. Be concrete: name the main exports, the role of the file, and any notable side effects. Max 6 lines.",
    messages: [
      {
        role: "user",
        content: `Summarize ${path} (${file.totalLines} lines${file.sliced ? ", truncated" : ""}):\n\n${file.content.slice(0, 12000)}`,
      },
    ],
  });
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  summaryCache.set(key, text);
  return text;
}

const MAX_TOOL_OUTPUT_CHARS = 24_000;

function clip(s: string): string {
  if (s.length <= MAX_TOOL_OUTPUT_CHARS) return s;
  return s.slice(0, MAX_TOOL_OUTPUT_CHARS) + `\n…[truncated, ${s.length - MAX_TOOL_OUTPUT_CHARS} chars elided]`;
}

export type ToolExecResult = {
  output: string;
  isError: boolean;
};

export async function executeTool(
  repo: RepoRef,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolExecResult> {
  try {
    switch (name) {
      case "list_files": {
        const path = typeof input.path === "string" ? input.path : "";
        const files = await listFiles(repo, path);
        if (!files.length) return { output: `(no entries under "${path}")`, isError: false };
        const header = path ? `Contents of ${path}:` : `Repo root (${repo.owner}/${repo.repo}@${repo.ref}):`;
        return { output: clip(`${header}\n${files.join("\n")}`), isError: false };
      }
      case "read_file": {
        const path = String(input.path ?? "");
        const start = typeof input.start_line === "number" ? input.start_line : undefined;
        const end = typeof input.end_line === "number" ? input.end_line : undefined;
        if (!path) return { output: "Error: 'path' is required", isError: true };
        const f = await readFile(repo, path, start, end);
        const header = `${f.path} (${f.totalLines} lines${f.sliced ? ", showing slice" : ""}):`;
        return { output: clip(`${header}\n${f.content}`), isError: false };
      }
      case "search_code": {
        const query = String(input.query ?? "");
        if (!query) return { output: "Error: 'query' is required", isError: true };
        const hits = await searchCode(repo, query);
        if (!hits.length) return { output: `No matches for "${query}".`, isError: false };
        const lines = hits.map((h) => `${h.path}:${h.line}  ${h.snippet}`);
        return { output: clip(`Matches for "${query}":\n${lines.join("\n")}`), isError: false };
      }
      case "get_file_summary": {
        const path = String(input.path ?? "");
        if (!path) return { output: "Error: 'path' is required", isError: true };
        const summary = await summarizeFile(repo, path);
        return { output: `Summary of ${path}:\n${summary}`, isError: false };
      }
      default:
        return { output: `Unknown tool: ${name}`, isError: true };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `Tool ${name} failed: ${msg}`, isError: true };
  }
}
