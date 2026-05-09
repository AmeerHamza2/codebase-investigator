import Anthropic from "@anthropic-ai/sdk";

let _client: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  _client = new Anthropic({ apiKey });
  return _client;
}

export const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5";

// Translate raw Anthropic SDK errors into messages a user can act on.
// We surface the result directly in the UI's error banner.
export function friendlyAnthropicError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/credit balance is too low|insufficient_quota/i.test(msg)) {
    return "Anthropic credit balance is exhausted. Top up at https://console.anthropic.com/settings/billing, or set a different ANTHROPIC_API_KEY in .env and restart the dev server.";
  }
  if (/invalid x-api-key|authentication_error/i.test(msg)) {
    return "Anthropic API key is invalid. Check ANTHROPIC_API_KEY in .env (regenerate at https://console.anthropic.com/settings/keys), then restart the dev server.";
  }
  if (/rate_limit|429/i.test(msg)) {
    return "Anthropic rate limit hit. Wait a moment and retry the question.";
  }
  if (/overloaded|529/i.test(msg)) {
    return "Anthropic API is overloaded right now. Wait a few seconds and retry.";
  }
  if (/model.*not_found|not_found_error/i.test(msg)) {
    return `Anthropic doesn't recognize the model in CLAUDE_MODEL (currently "${MODEL}"). Try claude-haiku-4-5 or claude-sonnet-4-5.`;
  }
  return msg;
}
