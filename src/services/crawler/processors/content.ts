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
 * Enhanced metadata extraction function that prioritizes OpenGraph and proper title elements
 * @param doc HTML document or string
 * @returns Extracted metadata
 */
export function extractMetadata(doc: Document | string): {
  title: string;
  metaDescription: string;
  canonicalUrl: string;
  openGraph: Record<string, string>;
  twitterCard: Record<string, string>;
} {
  // Initialize result object
  const result = {
    title: "",
    metaDescription: "",
    canonicalUrl: "",
    openGraph: {} as Record<string, string>,
    twitterCard: {} as Record<string, string>,
  };

  // If input is string and we're in a browser-like environment, try to parse it
  let documentObj: Document | null = null;

  if (typeof doc === "string") {
    try {
      if (typeof DOMParser !== "undefined") {
        const parser = new DOMParser();
        documentObj = parser.parseFromString(doc as string, "text/html");
      } else {
        // Extract using regex if no DOM parser available
        // Title extraction
        const titleMatch = (doc as string).match(/<title[^>]*>(.*?)<\/title>/i);
        if (titleMatch && titleMatch[1]) {
          result.title = titleMatch[1].trim();
        }

        // Meta description extraction
        const metaMatch =
          (doc as string).match(
            /<meta\s+name=["']description["']\s+content=["'](.*?)["']/i,
          ) ||
          (doc as string).match(
            /<meta\s+content=["'](.*?)["']\s+name=["']description["']/i,
          );
        if (metaMatch && metaMatch[1]) {
          result.metaDescription = metaMatch[1].trim();
        }

        // Canonical URL extraction
        const canonicalMatch = (doc as string).match(
          /<link\s+rel=["']canonical["']\s+href=["'](.*?)["']/i,
        );
        if (canonicalMatch && canonicalMatch[1]) {
          result.canonicalUrl = canonicalMatch[1].trim();
        }

        // Return early since we can't do more complex extraction without a DOM
        return result;
      }
    } catch (error) {
      console.error("Error parsing HTML:", error);
      return result;
    }
  } else {
    documentObj = doc as Document;
  }

  if (!documentObj) {
    return result;
  }

  // TITLE EXTRACTION PRIORITY:
  // 1. OpenGraph title (most reliable for social sharing)
  // 2. Regular title tag
  // 3. Fallback to h1 if neither exists

  // First check OpenGraph title since it's most specific
  const ogTitle = documentObj.querySelector('meta[property="og:title"]');
  if (ogTitle && ogTitle.getAttribute("content")) {
    result.title = ogTitle.getAttribute("content")!.trim();
  }
  // Then check regular title tag
  else {
    const titleElement = documentObj.querySelector("title");
    if (titleElement && titleElement.textContent) {
      result.title = titleElement.textContent.trim();
    }
    // Last resort: use first h1
    else {
      const h1 = documentObj.querySelector("h1");
      if (h1 && h1.textContent) {
        result.title = h1.textContent.trim();
      }
    }
  }

  // Clean up common title issues
  if (result.title) {
    // Remove excessive whitespace
    result.title = result.title.replace(/\s+/g, " ").trim();

    // Remove common SEO suffixes like "- Company Name" if title is very long
    if (result.title.length > 60 && result.title.includes(" - ")) {
      result.title = result.title.split(" - ")[0].trim();
    }

    // Ensure we don't capture payment gateway names as titles
    // Filter out titles that are just payment provider names
    const paymentProviders = [
      "American Express",
      "Visa",
      "MasterCard",
      "PayPal",
      "Apple Pay",
      "Google Pay",
      "Stripe",
      "Shop Pay",
      "Checkout",
    ];

    if (paymentProviders.includes(result.title)) {
      // In this case, look for another title element or use URL path
      const titleElement = documentObj.querySelector("title");
      if (
        titleElement &&
        titleElement.textContent &&
        !paymentProviders.includes(titleElement.textContent.trim())
      ) {
        result.title = titleElement.textContent.trim();
      } else {
        // If we're still getting a payment provider, try to get the URL path
        const canonical = documentObj.querySelector('link[rel="canonical"]');
        if (canonical && canonical.getAttribute("href")) {
          try {
            const url = new URL(canonical.getAttribute("href")!);
            const pathSegments = url.pathname.split("/").filter(Boolean);
            if (pathSegments.length > 0) {
              // Use last path segment, replace hyphens with spaces and capitalize
              result.title = pathSegments[pathSegments.length - 1]
                .replace(/-/g, " ")
                .replace(/\b\w/g, (l) => l.toUpperCase());
            }
          } catch (e) {
            // URL parsing failed, keep what we have
          }
        }
      }
    }
  }

  // Extract meta description
  const metaDescription = documentObj.querySelector('meta[name="description"]');
  if (metaDescription && metaDescription.getAttribute("content")) {
    result.metaDescription = metaDescription.getAttribute("content")!.trim();
  }

  // Extract canonical URL
  const canonical = documentObj.querySelector('link[rel="canonical"]');
  if (canonical && canonical.getAttribute("href")) {
    result.canonicalUrl = canonical.getAttribute("href")!.trim();
  }

  // Extract Open Graph metadata
  const ogTags = documentObj.querySelectorAll('meta[property^="og:"]');
  ogTags.forEach((tag) => {
    const property = tag.getAttribute("property");
    const content = tag.getAttribute("content");
    if (property && content) {
      result.openGraph[property.replace("og:", "")] = content.trim();
    }
  });

  // Extract Twitter Card metadata
  const twitterTags = documentObj.querySelectorAll('meta[name^="twitter:"]');
  twitterTags.forEach((tag) => {
    const name = tag.getAttribute("name");
    const content = tag.getAttribute("content");
    if (name && content) {
      result.twitterCard[name.replace("twitter:", "")] = content.trim();
    }
  });

  return result;
}
