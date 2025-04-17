import axios from "axios";
import * as cheerio from "cheerio";

interface ScanResult {
  url: string;
  title: string;
  meta_description: string;
  h1s: string[];
  h2s: string[];
  h3s: string[];
  h4s: string[];
  h5s: string[];
  h6s: string[];
  content_length: number;
  word_count: number;
  open_graph: Record<string, string>;
  twitter_card: Record<string, string>;
  canonical_url: string | null;
  http_status: number;
  is_indexable: boolean;
  has_robots_noindex: boolean;
  has_robots_nofollow: boolean;
  depth: number;
  redirect_url: string | null;
  content_type: string;
  size_bytes: number;
  load_time_ms: number;
  first_byte_time_ms: number;
  structured_data: any[];
  schema_types: string[];
  images: Array<{ src: string; alt: string }>;
  js_count: number;
  css_count: number;
  keywords: { word: string; count: number }[];
  internal_links: Array<{
    url: string;
    anchor_text: string;
    rel_attributes: string[];
  }>;
  external_links: Array<{
    url: string;
    anchor_text: string;
    rel_attributes: string[];
  }>;
}

export async function scanWebsite(
  url: string,
  depth: number = 0,
): Promise<ScanResult> {
  try {
    // Ensure URL has proper protocol
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = "https://" + url;
    }

    const startTime = Date.now();
    let firstByteTime = 0;

    // Fetch the website content
    const response = await axios.get(url, {
      maxRedirects: 5,
      validateStatus: (status) => status < 400, // Accept all status codes less than 400
      onDownloadProgress: (progressEvent) => {
        if (progressEvent.loaded > 0 && firstByteTime === 0) {
          firstByteTime = Date.now() - startTime;
        }
      },
      headers: {
        "User-Agent": "RankRiot Crawler/1.0",
      },
    });

    const loadTime = Date.now() - startTime;
    const html = response.data;
    const size = Buffer.byteLength(
      typeof html === "string" ? html : JSON.stringify(html),
    );

    // Load the HTML into cheerio
    const $ = cheerio.load(html);

    // Extract meta title
    const metaTitle =
      $("title").text() || $('meta[property="og:title"]').attr("content") || "";

    // Extract meta description
    const metaDescription =
      $('meta[name="description"]').attr("content") ||
      $('meta[property="og:description"]').attr("content") ||
      "";

    // Extract headings
    const h1Tags = $("h1")
      .map((_, el) => $(el).text().trim())
      .get();
    const h2Tags = $("h2")
      .map((_, el) => $(el).text().trim())
      .get();
    const h3Tags = $("h3")
      .map((_, el) => $(el).text().trim())
      .get();
    const h4Tags = $("h4")
      .map((_, el) => $(el).text().trim())
      .get();
    const h5Tags = $("h5")
      .map((_, el) => $(el).text().trim())
      .get();
    const h6Tags = $("h6")
      .map((_, el) => $(el).text().trim())
      .get();

    // Calculate content length and word count
    const content = $("body").text().trim();
    const contentLength = content.length;
    const wordCount = content
      .split(/\s+/)
      .filter((word) => word.length > 0).length;

    // Extract Open Graph data
    const openGraph: Record<string, string> = {};
    $('meta[property^="og:"]').each((_, el) => {
      const property = $(el).attr("property")?.replace("og:", "") || "";
      const content = $(el).attr("content") || "";
      if (property && content) {
        openGraph[property] = content;
      }
    });

    // Extract Twitter Card data
    const twitterCard: Record<string, string> = {};
    $('meta[name^="twitter:"]').each((_, el) => {
      const name = $(el).attr("name")?.replace("twitter:", "") || "";
      const content = $(el).attr("content") || "";
      if (name && content) {
        twitterCard[name] = content;
      }
    });

    // Extract canonical URL
    const canonicalUrl = $('link[rel="canonical"]').attr("href") || null;

    // Check robots meta tags
    const robotsContent = $('meta[name="robots"]').attr("content") || "";
    const hasNoindex = robotsContent.toLowerCase().includes("noindex");
    const hasNofollow = robotsContent.toLowerCase().includes("nofollow");

    // Determine if page is indexable
    const isIndexable = !hasNoindex;

    // Extract structured data and schema types
    const structuredData: any[] = [];
    const schemaTypes: string[] = [];
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const data = JSON.parse($(el).html() || "{}");
        structuredData.push(data);

        // Extract schema types
        if (data["@type"]) {
          if (Array.isArray(data["@type"])) {
            schemaTypes.push(...data["@type"]);
          } else {
            schemaTypes.push(data["@type"]);
          }
        }
      } catch (e) {
        console.error("Error parsing JSON-LD:", e);
      }
    });

    // Extract images with alt text
    const images = $("img")
      .map((_, el) => {
        const src = $(el).attr("src") || "";
        const alt = $(el).attr("alt") || "";

        if (src.length === 0) return null;

        // Handle relative URLs
        let fullSrc = src;
        if (src.startsWith("/")) {
          const baseUrl = new URL(url);
          fullSrc = `${baseUrl.origin}${src}`;
        } else if (!src.startsWith("http://") && !src.startsWith("https://")) {
          // Handle relative URLs that don't start with a slash
          fullSrc = new URL(src, url).href;
        }

        return { src: fullSrc, alt };
      })
      .get()
      .filter((image): image is { src: string; alt: string } => image !== null);

    // Count JavaScript files
    const jsCount = $("script[src]").length;

    // Count CSS files
    const cssCount = $('link[rel="stylesheet"], style').length;

    // Extract links and categorize them
    const baseUrl = new URL(url);
    const internalLinks: Array<{
      url: string;
      anchor_text: string;
      rel_attributes: string[];
    }> = [];
    const externalLinks: Array<{
      url: string;
      anchor_text: string;
      rel_attributes: string[];
    }> = [];

    $("a[href]").each((_, el) => {
      let href = $(el).attr("href") || "";
      const anchorText = $(el).text().trim();
      const relAttr = $(el).attr("rel") || "";
      const relAttributes = relAttr
        .split(" ")
        .filter((attr) => attr.length > 0);

      // Skip empty, javascript, and anchor links
      if (!href || href.startsWith("javascript:") || href === "#") {
        return;
      }

      // Handle relative URLs
      if (href.startsWith("/")) {
        href = `${baseUrl.origin}${href}`;
      } else if (!href.startsWith("http://") && !href.startsWith("https://")) {
        // Handle relative URLs that don't start with a slash
        try {
          href = new URL(href, url).href;
        } catch (e) {
          return; // Skip invalid URLs
        }
      }

      try {
        const linkUrl = new URL(href);
        const linkData = {
          url: href,
          anchor_text: anchorText,
          rel_attributes: relAttributes,
        };

        // Check if it's an internal or external link
        if (linkUrl.hostname === baseUrl.hostname) {
          if (!internalLinks.some((link) => link.url === href)) {
            internalLinks.push(linkData);
          }
        } else {
          if (!externalLinks.some((link) => link.url === href)) {
            externalLinks.push(linkData);
          }
        }
      } catch (e) {
        console.error(`Error parsing URL: ${href}`, e);
      }
    });

    // Extract keywords (simple implementation - can be improved)
    const stopWords = new Set([
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
      "me",
      "more",
      "most",
      "my",
      "myself",
      "no",
      "nor",
      "not",
      "of",
      "off",
      "on",
      "once",
      "only",
      "or",
      "other",
      "ought",
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
      "with",
      "would",
      "you",
      "your",
      "yours",
      "yourself",
      "yourselves",
    ]);

    const words = content
      .toLowerCase()
      .split(/\W+/)
      .filter(
        (word) =>
          word.length > 3 && !stopWords.has(word) && /^[a-z]+$/.test(word),
      );

    const wordFrequency: Record<string, number> = {};
    for (const word of words) {
      wordFrequency[word] = (wordFrequency[word] || 0) + 1;
    }

    const keywords = Object.entries(wordFrequency)
      .map(([word, count]) => ({ word, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20); // Get top 20 keywords

    // Determine redirect URL
    const redirectUrl =
      response.request?.res?.responseUrl !== url
        ? response.request?.res?.responseUrl
        : null;

    return {
      url: url,
      title: metaTitle,
      meta_description: metaDescription,
      h1s: h1Tags,
      h2s: h2Tags,
      h3s: h3Tags,
      h4s: h4Tags,
      h5s: h5Tags,
      h6s: h6Tags,
      content_length: contentLength,
      word_count: wordCount,
      open_graph: openGraph,
      twitter_card: twitterCard,
      canonical_url: canonicalUrl,
      http_status: response.status,
      is_indexable: isIndexable,
      has_robots_noindex: hasNoindex,
      has_robots_nofollow: hasNofollow,
      depth: depth,
      redirect_url: redirectUrl,
      content_type: response.headers["content-type"] || "",
      size_bytes: size,
      load_time_ms: loadTime,
      first_byte_time_ms: firstByteTime,
      structured_data: structuredData,
      schema_types: schemaTypes,
      images: images,
      js_count: jsCount,
      css_count: cssCount,
      keywords: keywords,
      internal_links: internalLinks,
      external_links: externalLinks,
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      // Handle specific Axios errors
      const status = error.response?.status || 0;
      const contentType = error.response?.headers["content-type"] || "";

      return {
        url: url,
        title: "",
        meta_description: "",
        h1s: [],
        h2s: [],
        h3s: [],
        h4s: [],
        h5s: [],
        h6s: [],
        content_length: 0,
        word_count: 0,
        open_graph: {},
        twitter_card: {},
        canonical_url: null,
        http_status: status,
        is_indexable: false,
        has_robots_noindex: false,
        has_robots_nofollow: false,
        depth: depth,
        redirect_url: null,
        content_type: contentType,
        size_bytes: 0,
        load_time_ms: 0,
        first_byte_time_ms: 0,
        structured_data: [],
        schema_types: [],
        images: [],
        js_count: 0,
        css_count: 0,
        keywords: [],
        internal_links: [],
        external_links: [],
      };
    }

    console.error(`Error scanning website ${url}:`, error);
    throw new Error(
      `Failed to scan website: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
