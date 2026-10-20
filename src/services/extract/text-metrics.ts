import { createHash } from "crypto";

/**
 * Pure text metrics shared by the HTTP and headless extraction paths and by the
 * known-answer test suite. Lifted verbatim (behaviour-preserving) from the
 * Scanner private methods so there is ONE implementation of each.
 */

const STOP_WORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
  "her", "was", "one", "our", "out", "has", "its", "let", "say", "she",
  "too", "use", "that", "with", "this", "have", "from", "they", "been",
  "said", "each", "make", "like", "long", "look", "many", "some", "than",
  "them", "then", "what", "when", "will", "more", "into", "over", "such",
  "take", "also", "back", "came", "come", "just", "only", "very", "well",
  "your", "were", "which", "about", "after", "being", "could", "every",
  "first", "found", "great", "their", "there", "these", "those", "under",
  "where", "while", "would", "other", "still", "between", "should", "through",
]);

// Safety net: even though text is entity-decoded upstream, never let an HTML
// entity name leak through as a "keyword" (e.g. rsquo, nbsp, amp).
const ENTITY_NAMES = new Set([
  "amp", "lt", "gt", "quot", "apos", "nbsp", "rsquo", "lsquo", "rdquo",
  "ldquo", "ndash", "mdash", "hellip", "copy", "reg", "trade", "deg",
  "middot", "bull", "dagger", "laquo", "raquo", "hearts", "frac",
]);

export function extractKeywords(
  text: string,
): Array<{ word: string; count: number }> {
  const words = text.toLowerCase().match(/[\p{L}]{4,}/gu) || [];
  const freq = new Map<string, number>();
  for (const word of words) {
    if (!STOP_WORDS.has(word) && !ENTITY_NAMES.has(word)) {
      freq.set(word, (freq.get(word) || 0) + 1);
    }
  }
  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word, count]) => ({ word, count }));
}

/** SHA-256 of normalised text, for duplicate-content detection. */
export function computeContentHash(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(normalized).digest("hex");
}

function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length <= 3) return 1;
  const vowelGroups = w.match(/[aeiouy]+/g);
  let count = vowelGroups ? vowelGroups.length : 1;
  if (w.endsWith("e")) count--;
  if (w.endsWith("le") && w.length > 2 && !/[aeiouy]/.test(w[w.length - 3])) count++;
  return Math.max(1, count);
}

/** Flesch Reading Ease (0-100, higher = easier). */
export function computeReadabilityScore(text: string): number {
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);

  if (sentences.length === 0 || words.length === 0) return 0;

  const avgWordsPerSentence = words.length / sentences.length;
  const avgSyllablesPerWord = syllables / words.length;

  const score = 206.835 - 1.015 * avgWordsPerSentence - 84.6 * avgSyllablesPerWord;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/** Count words in a block of already-decoded, tag-free text. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}
