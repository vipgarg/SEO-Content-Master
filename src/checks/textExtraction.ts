// Extraction primitives shared by exactMatch.ts and thinContent.ts.
// All pure, all regex/heuristic — deliberately no NLP dependency. This
// is the "free, deterministic" layer the plan wants ahead of any model
// call, so it has to work without one.

/** Every numeric literal in text, as parsed numbers (commas stripped). */
export function extractNumbers(text: string): number[] {
  const matches = text.match(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g) ?? [];
  return matches.map((m) => Number.parseFloat(m.replace(/,/g, "")));
}

const MONTHS: Record<string, string> = {
  jan: "01", january: "01",
  feb: "02", february: "02",
  mar: "03", march: "03",
  apr: "04", april: "04",
  may: "05",
  jun: "06", june: "06",
  jul: "07", july: "07",
  aug: "08", august: "08",
  sep: "09", sept: "09", september: "09",
  oct: "10", october: "10",
  nov: "11", november: "11",
  dec: "12", december: "12",
};

function pad2(n: string | number): string {
  return String(n).padStart(2, "0");
}

/** Every date in text, normalized to ISO "YYYY-MM-DD". Best-effort over a few common formats. */
export function extractDates(text: string): string[] {
  const results: string[] = [];

  // ISO: 2025-06-01
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    results.push(`${m[1]}-${m[2]}-${m[3]}`);
  }

  // "1 June 2025" / "1st June 2025"
  const monthNames = Object.keys(MONTHS).join("|");
  const dmyRe = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthNames})\\.?\\s+(\\d{4})\\b`, "gi");
  for (const m of text.matchAll(dmyRe)) {
    const month = MONTHS[m[2]!.toLowerCase()];
    if (month) results.push(`${m[3]}-${month}-${pad2(m[1]!)}`);
  }

  // "June 1, 2025" / "June 2025" (no day — treated as the 1st for comparison purposes)
  const mdyRe = new RegExp(`\\b(${monthNames})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi");
  for (const m of text.matchAll(mdyRe)) {
    const month = MONTHS[m[1]!.toLowerCase()];
    if (month) results.push(`${m[3]}-${month}-${pad2(m[2]!)}`);
  }

  return results;
}

/** ISBN-13 and ISBN-10 candidates, normalized (digits/X only, no hyphens/spaces). */
export function extractIsbns(text: string): string[] {
  const candidates = text.match(/\b(?:97[89][\d-\s]{10,17}|\d[\d-\s]{8,12}[\dXx])\b/g) ?? [];
  return candidates
    .map((c) => c.replace(/[\s-]/g, "").toUpperCase())
    .filter((c) => c.length === 10 || c.length === 13);
}

// Combining diacritical marks (U+0300–U+036F) — what NFKD decomposition
// leaves behind on accented characters, e.g. "é" -> "e" + U+0301.
const COMBINING_MARKS_RE = /[̀-ͯ]/g;

/** Lowercase, trim, collapse whitespace, strip most punctuation — for substring entity matching. */
export function normalizeEntityText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(COMBINING_MARKS_RE, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Splits rendered text into sentences. Deliberately simple — good enough for skeleton/ratio checks, not a real sentence boundary detector. */
export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * A structural fingerprint of a sentence for the §4a "non-templated
 * sentence ratio" check: numbers collapsed to a placeholder,
 * capitalized runs (proper nouns — titles, names) collapsed to
 * another, then lowercased/whitespace-collapsed. Two sentences that
 * differ only in which book/number/date they name reduce to the same
 * skeleton — which is exactly the "unique text, interchangeable
 * content" pattern §4a exists to catch.
 */
export function sentenceSkeleton(sentence: string): string {
  return sentence
    .replace(/\d[\d,.\s]*\d|\d/g, "#")
    .replace(/\b[A-Z][a-zA-Z'-]*(?:\s+[A-Z][a-zA-Z'-]*)*/g, "@")
    .toLowerCase()
    .replace(/[^\w\s#@]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
