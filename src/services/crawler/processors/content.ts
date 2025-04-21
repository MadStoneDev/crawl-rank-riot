/**
 * Utilities for processing and analyzing web page content
 */

/**
 * Common stop words to exclude from keyword analysis
 */
const STOP_WORDS = new Set([
  "a",
  "about",
  "above",
  "after",
  "again",
  "against",
  "all",
  "am",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "because",
  "been",
  "before",
  "being",
  "below",
  "between",
  "both",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "doing",
  "down",
  "during",
  "each",
  "few",
  "for",
  "from",
  "further",
  "had",
  "has",
  "have",
  "having",
  "he",
  "her",
  "here",
  "hers",
  "herself",
  "him",
  "himself",
  "his",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "itself",
  "just",
  "me",
  "more",
  "most",
  "my",
  "myself",
  "no",
  "nor",
  "not",
  "now",
  "of",
  "off",
  "on",
  "once",
  "only",
  "or",
  "other",
  "our",
  "ours",
  "ourselves",
  "out",
  "over",
  "own",
  "same",
  "she",
  "should",
  "so",
  "some",
  "such",
  "than",
  "that",
  "the",
  "their",
  "theirs",
  "them",
  "themselves",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "to",
  "too",
  "under",
  "until",
  "up",
  "very",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "whom",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
  "yours",
  "yourself",
  "yourselves",
]);

/**
 * Technical terms to exclude from keyword analysis
 */
const TECHNICAL_TERMS = new Set([
  "null",
  "undefined",
  "function",
  "const",
  "var",
  "let",
  "return",
  "import",
  "export",
  "default",
  "class",
  "classname",
  "props",
  "children",
  "div",
  "span",
  "component",
  "static",
  "font",
  "width",
  "height",
  "margin",
  "padding",
  "border",
  "flex",
  "grid",
  "container",
  "wrapper",
  "header",
  "footer",
  "main",
  "section",
  "article",
  "nav",
  "aside",
  "true",
  "false",
  "object",
  "array",
  "string",
  "number",
  "boolean",
  "void",
  "interface",
  "type",
  "extends",
  "implements",
  "module",
  "namespace",
]);

/**
 * Options for extracting visible text
 */
export interface TextExtractionOptions {
  removeScripts?: boolean;
  removeStyles?: boolean;
  normalizeWhitespace?: boolean;
}

/**
 * Extract visible text content from HTML
 * @param html HTML content
 * @param options Text extraction options
 * @returns Extracted visible text
 */
export function extractVisibleText(
  html: string | Document,
  options: TextExtractionOptions = {},
): string {
  const {
    removeScripts = true,
    removeStyles = true,
    normalizeWhitespace = true,
  } = options;

  let doc: Document;

  if (typeof html === "string") {
    // If in browser environment, use DOMParser
    if (typeof DOMParser !== "undefined") {
      const parser = new DOMParser();
      doc = parser.parseFromString(html, "text/html");
    } else {
      // Very basic text extraction for non-browser environments
      return extractTextWithRegex(html);
    }
  } else {
    doc = html;
  }

  // Remove scripts if requested
  if (removeScripts) {
    const scripts = doc.querySelectorAll("script, noscript");
    scripts.forEach((script) => script.remove());
  }

  // Remove styles if requested
  if (removeStyles) {
    const styles = doc.querySelectorAll("style");
    styles.forEach((style) => style.remove());
  }

  // Also remove other non-visible elements
  const nonVisibleElements = doc.querySelectorAll(
    'meta, link, [style*="display: none"], [style*="display:none"], [hidden]',
  );
  nonVisibleElements.forEach((elem) => elem.remove());

  // Get text content from body
  let text = doc.body ? doc.body.textContent || "" : "";

  // Normalize whitespace if requested
  if (normalizeWhitespace) {
    text = text.replace(/\s+/g, " ").trim();
  }

  return text;
}

/**
 * Simple text extraction using regex (fallback for non-browser environments)
 * @param html HTML content
 * @returns Extracted text
 */
function extractTextWithRegex(html: string): string {
  // Remove tags and decode entities
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Options for keyword extraction
 */
export interface KeywordExtractionOptions {
  maxKeywords?: number;
  minWordLength?: number;
  minCount?: number;
  excludeNumbers?: boolean;
}

/**
 * Extract keywords from text content
 * @param text Text content
 * @param options Keyword extraction options
 * @returns Array of keywords with counts
 */
export function extractKeywords(
  text: string,
  options: KeywordExtractionOptions = {},
): Array<{ word: string; count: number }> {
  const {
    maxKeywords = 20,
    minWordLength = 3,
    minCount = 2,
    excludeNumbers = true,
  } = options;

  // Normalize text: convert to lowercase and replace non-alphanumeric chars with spaces
  const normalizedText = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ");

  // Split into words and filter
  const words = normalizedText.split(/\s+/).filter((word) => {
    // Skip short words
    if (word.length < minWordLength) return false;

    // Skip stop words
    if (STOP_WORDS.has(word)) return false;

    // Skip technical terms
    if (TECHNICAL_TERMS.has(word)) return false;

    // Skip numbers if requested
    if (excludeNumbers && /^\d+$/.test(word)) return false;

    // Only keep pure alphabetic words (or alphanumeric if numbers are allowed)
    return excludeNumbers ? /^[a-z]+$/.test(word) : /^[a-z0-9]+$/.test(word);
  });

  // Count word frequencies
  const wordCounts: Record<string, number> = {};
  for (const word of words) {
    wordCounts[word] = (wordCounts[word] || 0) + 1;
  }

  // Convert to array, filter by minimum count, sort by frequency, and take top N
  return Object.entries(wordCounts)
    .filter(([_, count]) => count >= minCount)
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, maxKeywords);
}

/**
 * Calculate estimated reading time
 * @param text Text content
 * @param wordsPerMinute Reading speed in words per minute
 * @returns Reading time in minutes
 */
export function calculateReadingTime(
  text: string,
  wordsPerMinute = 200,
): number {
  const words = text.split(/\s+/).filter((word) => word.length > 0).length;
  return Math.ceil(words / wordsPerMinute);
}

/**
 * Extract metadata from HTML
 * @param html HTML content or Document
 * @returns Extracted metadata
 */
export function extractMetadata(html: string | Document): {
  title: string;
  metaDescription: string;
  openGraph: Record<string, string>;
  twitterCard: Record<string, string>;
  canonicalUrl: string | null;
} {
  let doc: Document;

  if (typeof html === "string") {
    if (typeof DOMParser !== "undefined") {
      const parser = new DOMParser();
      doc = parser.parseFromString(html, "text/html");
    } else {
      // Return empty metadata if DOMParser is not available
      return {
        title: "",
        metaDescription: "",
        openGraph: {},
        twitterCard: {},
        canonicalUrl: null,
      };
    }
  } else {
    doc = html;
  }

  // Extract title
  const title = doc.querySelector("title")?.textContent || "";

  // Extract meta description
  const metaDescription =
    doc.querySelector('meta[name="description"]')?.getAttribute("content") ||
    "";

  // Extract Open Graph data
  const openGraph: Record<string, string> = {};
  doc.querySelectorAll('meta[property^="og:"]').forEach((el) => {
    const property = el.getAttribute("property")?.replace("og:", "") || "";
    const content = el.getAttribute("content") || "";
    if (property && content) {
      openGraph[property] = content;
    }
  });

  // Extract Twitter Card data
  const twitterCard: Record<string, string> = {};
  doc.querySelectorAll('meta[name^="twitter:"]').forEach((el) => {
    const name = el.getAttribute("name")?.replace("twitter:", "") || "";
    const content = el.getAttribute("content") || "";
    if (name && content) {
      twitterCard[name] = content;
    }
  });

  // Extract canonical URL
  const canonicalUrl =
    doc.querySelector('link[rel="canonical"]')?.getAttribute("href") || null;

  return {
    title,
    metaDescription,
    openGraph,
    twitterCard,
    canonicalUrl,
  };
}
