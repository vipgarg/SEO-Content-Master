// Helpers for enqueueing verification work onto the gemini-verification
// queue, so callers (the generation pipeline) don't need to know the
// job-options contract (attempts/backoff type) themselves.

import type { Queue } from "bullmq";
import { defaultGeminiJobOptions } from "./queue.js";
import type {
  BannedClaimJobData,
  EntailmentItem,
  GeminiJobData,
  RubricJobData,
} from "./types.js";

const MAX_ENTAILMENT_BATCH = 25; // plan §5 Step 5

export async function enqueueEntailment(
  queue: Queue<GeminiJobData>,
  pageId: number,
  items: EntailmentItem[],
): Promise<void> {
  if (items.length === 0) return;
  if (items.length > MAX_ENTAILMENT_BATCH) {
    throw new Error(
      `Entailment batch for page ${pageId} has ${items.length} claims, ` +
        `over the ${MAX_ENTAILMENT_BATCH}-claim cap (plan §5 Step 5) — split the page.`,
    );
  }
  await queue.add(
    "entailment",
    { stage: "entailment", pageId, items },
    defaultGeminiJobOptions(),
  );
}

export async function enqueueBannedClaimScan(
  queue: Queue<GeminiJobData>,
  pageId: number,
  renderedText: string,
): Promise<void> {
  const data: BannedClaimJobData = { stage: "banned_claim", pageId, renderedText };
  await queue.add("banned_claim", data, defaultGeminiJobOptions());
}

export async function enqueueRubricScore(
  queue: Queue<GeminiJobData>,
  pageId: number,
  args: Omit<RubricJobData, "stage" | "pageId">,
): Promise<void> {
  const data: RubricJobData = { stage: "rubric", pageId, ...args };
  await queue.add("rubric", data, defaultGeminiJobOptions());
}
