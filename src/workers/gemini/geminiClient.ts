// Thin client for the Gemini free-tier REST API (AI Studio /
// generativelanguage.googleapis.com), forcing JSON mode per plan §5.
//
// Deliberately has no retry/backoff logic of its own — that's the
// worker's job (queue.ts), driven by the error types thrown here. This
// module's only responsibility is: make the call, force JSON, and
// classify the outcome (429 vs. other failure) correctly.

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

export class GeminiRateLimitError extends Error {
  constructor(message = "Gemini API rate limit (429)") {
    super(message);
    this.name = "GeminiRateLimitError";
  }
}

export class GeminiApiError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "GeminiApiError";
    this.status = status;
  }
}

export interface GeminiCallOptions {
  apiKey: string;
  model: string; // 'gemini-flash-latest' | 'gemini-flash-lite-latest', etc.
  systemInstruction?: string;
  prompt: string;
  /** Fetch injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface GeminiCallResult<T> {
  data: T;
  promptTokens?: number;
  responseTokens?: number;
}

/**
 * Calls Gemini in forced-JSON mode and returns the parsed JSON body
 * plus token usage (for verification_runs logging). Throws
 * GeminiRateLimitError on HTTP 429, GeminiApiError on anything else
 * that isn't a clean 2xx-with-valid-JSON response.
 */
export async function callGeminiJson<T>(opts: GeminiCallOptions): Promise<GeminiCallResult<T>> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const url = `${API_BASE}/models/${opts.model}:generateContent?key=${opts.apiKey}`;

  const body = {
    contents: [{ role: "user", parts: [{ text: opts.prompt }] }],
    ...(opts.systemInstruction
      ? { systemInstruction: { parts: [{ text: opts.systemInstruction }] } }
      : {}),
    generationConfig: {
      responseMimeType: "application/json",
    },
  };

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new GeminiApiError(`Network error calling Gemini: ${(err as Error).message}`);
  }

  if (response.status === 429) {
    throw new GeminiRateLimitError();
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new GeminiApiError(`Gemini API returned ${response.status}: ${text}`, response.status);
  }

  const payload = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new GeminiApiError("Gemini response had no candidate text");
  }

  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch (err) {
    throw new GeminiApiError(`Gemini response was not valid JSON: ${(err as Error).message}`);
  }

  return {
    data,
    promptTokens: payload.usageMetadata?.promptTokenCount,
    responseTokens: payload.usageMetadata?.candidatesTokenCount,
  };
}
