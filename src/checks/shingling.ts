// w-shingling + Jaccard similarity (plan §5 Step 4: "Shingled duplicate
// check against every published page"). Catches exact/near-duplicate
// text — a different, narrower check than the §4a thin-content gate,
// which catches pages that are each textually unique but structurally
// interchangeable. Both matter; neither substitutes for the other.

export function wordShingles(text: string, k = 5): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const shingles = new Set<string>();
  for (let i = 0; i + k <= words.length; i++) {
    shingles.add(words.slice(i, i + k).join(" "));
  }
  return shingles;
}

export function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of smaller) {
    if (larger.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export interface DuplicateMatch {
  maxSimilarity: number;
  matchedPageId: number | null;
}

export function maxSimilarityAgainstCorpus(
  text: string,
  corpus: readonly { pageId: number; text: string }[],
  k = 5,
): DuplicateMatch {
  const shingles = wordShingles(text, k);
  let maxSimilarity = 0;
  let matchedPageId: number | null = null;
  for (const page of corpus) {
    const similarity = jaccardSimilarity(shingles, wordShingles(page.text, k));
    if (similarity > maxSimilarity) {
      maxSimilarity = similarity;
      matchedPageId = page.pageId;
    }
  }
  return { maxSimilarity, matchedPageId };
}
