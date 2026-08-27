// Orchestrates plan §5 Steps 2–3: draft, then self-critique in the
// same call chain. Pure aside from the injected HTTP call — same split
// as everything else in this repo. `claudeCall` is injectable so this
// is fully testable without an API key, mirroring how queue.ts tests
// the gemini worker against a mocked geminiCall.

import { callClaudeJson, type ClaudeCallResult } from "./claudeClient.js";
import {
  buildDraftSystemPrompt,
  buildDraftUserMessage,
  buildSelfCritiqueUserMessage,
  DRAFT_TOOL_NAME,
  DRAFT_TOOL_SCHEMA,
} from "./prompts.js";
import { findUnknownEvidenceReferences, parseDraftPage } from "./parseDraft.js";
import type { GenerationInput, GenerationResult } from "./types.js";

export class GenerationError extends Error {
  readonly issues: readonly string[];
  constructor(message: string, issues: readonly string[]) {
    super(`${message}:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "GenerationError";
    this.issues = issues;
  }
}

export interface GenerateDraftDeps {
  apiKey: string;
  model: string;
  maxTokens?: number;
  /** Injectable for tests — defaults to the real HTTP client. */
  claudeCall?: typeof callClaudeJson;
}

export async function generateDraft(
  input: GenerationInput,
  deps: GenerateDraftDeps,
): Promise<GenerationResult> {
  const claudeCall = deps.claudeCall ?? callClaudeJson;
  const knownEvidenceIds = new Set(input.evidencePack.map((e) => e.id));

  // Step 2: draft.
  const draftCallResult: ClaudeCallResult<unknown> = await claudeCall({
    apiKey: deps.apiKey,
    model: deps.model,
    system: buildDraftSystemPrompt(input),
    userMessage: buildDraftUserMessage(input),
    toolName: DRAFT_TOOL_NAME,
    toolDescription: "Emit the complete structured page draft.",
    toolInputSchema: DRAFT_TOOL_SCHEMA,
    maxTokens: deps.maxTokens,
  });
  const initialDraft = parseDraftPage(draftCallResult.data);
  const initialHallucinations = findUnknownEvidenceReferences(initialDraft, knownEvidenceIds);
  if (initialHallucinations.length > 0) {
    throw new GenerationError("Draft cites evidence ids outside the pack it was given", initialHallucinations);
  }

  // Step 3: self-critique, same call chain, same tool contract so the
  // output is directly comparable/persistable the same way.
  const critiqueCallResult: ClaudeCallResult<unknown> = await claudeCall({
    apiKey: deps.apiKey,
    model: deps.model,
    system: buildDraftSystemPrompt(input),
    userMessage: buildSelfCritiqueUserMessage(input, initialDraft),
    toolName: DRAFT_TOOL_NAME,
    toolDescription: "Emit the corrected page draft.",
    toolInputSchema: DRAFT_TOOL_SCHEMA,
    maxTokens: deps.maxTokens,
  });
  const finalDraft = parseDraftPage(critiqueCallResult.data);
  const finalHallucinations = findUnknownEvidenceReferences(finalDraft, knownEvidenceIds);
  if (finalHallucinations.length > 0) {
    throw new GenerationError(
      "Self-critiqued draft cites evidence ids outside the pack it was given",
      finalHallucinations,
    );
  }

  return {
    draft: finalDraft,
    initialDraft,
    draftModel: deps.model,
    inputTokens: (draftCallResult.inputTokens ?? 0) + (critiqueCallResult.inputTokens ?? 0),
    outputTokens: (draftCallResult.outputTokens ?? 0) + (critiqueCallResult.outputTokens ?? 0),
  };
}
