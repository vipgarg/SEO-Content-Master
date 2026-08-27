// Banned-phrase regex check (plan §5 Step 4: "Banned-phrase regex list
// ('in today's fast-paced world', 'delve', 'look no further', etc.)").
//
// This is NOT the same list as the hard-reject banned-CLAIM scan (plan
// §5 Step 6 — exam guarantees, medical/legal/financial advice, etc.),
// which is Gemini's job because it requires judgement. This is pure
// pattern-matching against generic AI-content filler phrasing, and it
// belongs in the free deterministic pass because it needs none.
//
// The authoritative list lives in v2 §8d, which wasn't available when
// this was written. What's below is a reasonable starter set of the
// phrases most associated with unedited LLM output — swap in the real
// list from v2 §8d when it's available; the check function doesn't care
// what's in the list.

import type { CheckFailure } from "./types.js";

export const DEFAULT_BANNED_PHRASES: readonly string[] = [
  "in today's fast-paced world",
  "in the fast-paced world",
  "in today's digital age",
  "delve into",
  "look no further",
  "when it comes to",
  "it's important to note that",
  "it is important to note that",
  "in conclusion",
  "unlock the",
  "elevate your",
  "game-?changer",
  "unleash",
  "in the realm of",
  "navigate the",
  "a testament to",
  "stands as a",
  "boasts an? (?:impressive|remarkable|unparalleled)",
  "whether you'?re a .* or a",
];

function toRegex(phrase: string): RegExp {
  // Phrases may already be small regex fragments (e.g. "game-?changer");
  // treat them as such rather than escaping, since the list is meant to
  // be edited as regex, not literal strings.
  return new RegExp(phrase, "gi");
}

export function checkBannedPhrases(
  renderedText: string,
  phrases: readonly string[] = DEFAULT_BANNED_PHRASES,
): CheckFailure[] {
  const failures: CheckFailure[] = [];
  for (const phrase of phrases) {
    const match = toRegex(phrase).exec(renderedText);
    if (match) {
      failures.push({
        stage: "banned_phrase",
        code: "banned_phrase_found",
        message: `Found banned phrase pattern "${phrase}" (matched: "${match[0]}").`,
        severity: "page",
      });
    }
  }
  return failures;
}
