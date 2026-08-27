// Thin client for the Anthropic Messages API. Forces structured output
// via tool_choice rather than "please respond with JSON" — a forced
// tool call is validated against its input_schema server-side, which
// is more reliable than hoping a text response parses.
//
// Deliberately has no retry/backoff logic — same split as
// geminiClient.ts. This module makes the call and classifies the
// outcome; anything more belongs in a queue/worker if this pipeline
// ever needs one for Claude the way it does for Gemini.

const API_BASE = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export class ClaudeRateLimitError extends Error {
  constructor(message = "Claude API rate limit (429)") {
    super(message);
    this.name = "ClaudeRateLimitError";
  }
}

export class ClaudeOverloadedError extends Error {
  constructor(message = "Claude API overloaded (529)") {
    super(message);
    this.name = "ClaudeOverloadedError";
  }
}

export class ClaudeApiError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ClaudeApiError";
    this.status = status;
  }
}

export interface ClaudeCallOptions {
  apiKey: string;
  model: string;
  system: string;
  userMessage: string;
  /** Forces the model to call exactly this tool, whose input becomes the parsed result. */
  toolName: string;
  toolDescription: string;
  toolInputSchema: Record<string, unknown>; // JSON Schema
  maxTokens?: number;
  fetchImpl?: typeof fetch;
}

export interface ClaudeCallResult<T> {
  data: T;
  inputTokens?: number;
  outputTokens?: number;
}

export async function callClaudeJson<T>(opts: ClaudeCallOptions): Promise<ClaudeCallResult<T>> {
  const fetchFn = opts.fetchImpl ?? fetch;

  const body = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 8192,
    system: opts.system,
    messages: [{ role: "user", content: opts.userMessage }],
    tools: [
      {
        name: opts.toolName,
        description: opts.toolDescription,
        input_schema: opts.toolInputSchema,
      },
    ],
    tool_choice: { type: "tool", name: opts.toolName },
  };

  let response: Response;
  try {
    response = await fetchFn(API_BASE, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": opts.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new ClaudeApiError(`Network error calling Claude: ${(err as Error).message}`);
  }

  if (response.status === 429) throw new ClaudeRateLimitError();
  if (response.status === 529) throw new ClaudeOverloadedError();
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new ClaudeApiError(`Claude API returned ${response.status}: ${text}`, response.status);
  }

  const payload = (await response.json()) as {
    content?: Array<{ type: string; name?: string; input?: unknown }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  const toolUse = payload.content?.find((block) => block.type === "tool_use" && block.name === opts.toolName);
  if (!toolUse) {
    throw new ClaudeApiError(`Claude response had no tool_use block for "${opts.toolName}"`);
  }

  return {
    data: toolUse.input as T,
    inputTokens: payload.usage?.input_tokens,
    outputTokens: payload.usage?.output_tokens,
  };
}
