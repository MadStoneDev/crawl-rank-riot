import axios from "axios";
import * as cheerio from "cheerio";

interface ScanResult {
  page_url: string;
  meta_title: string;
  meta_description: string;
  h1_tags: string[];
  h2_tags: string[];
  h3_tags: string[];
  content_length: number;
  open_graph: Record<string, string>;
  twitter_card: Record<string, string>;
  canonical_url: string;
  http_status: number;
  is_indexable: boolean;
  has_noindex: boolean;
  has_nofollow: boolean;
  depth: number;
  redirect_url: string | null;
  content_type: string;
  size_bytes: number;
  load_time_ms: number;
  first_byte_time_ms: number;
  structured_data: any[];
  images: string[];
  js_count: number;
  css_count: number;
  internal_links: string[];
  external_links: string[];
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

    // Calculate content length
    const content = $("body").text().trim();
    const contentLength = content.length;

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
    const canonicalUrl = $('link[rel="canonical"]').attr("href") || "";

    // Check robots meta tags
    const robotsContent = $('meta[name="robots"]').attr("content") || "";
    const hasNoindex = robotsContent.toLowerCase().includes("noindex");
    const hasNofollow = robotsContent.toLowerCase().includes("nofollow");

    // Determine if page is indexable
    const isIndexable = !hasNoindex;

    // Extract structured data
    const structuredData: any[] = [];
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const data = JSON.parse($(el).html() || "{}");
        structuredData.push(data);
      } catch (e) {
        console.error("Error parsing JSON-LD:", e);
      }
    });

    // Extract images
    const images = $("img")
      .map((_, el) => $(el).attr("src") || "")
      .get()
      .filter((src) => src.length > 0)
      .map((src) => {
        // Handle relative URLs
        if (src.startsWith("/")) {
          const baseUrl = new URL(url);
          return `${baseUrl.origin}${src}`;
        }
        return src;
      });

    // Count JavaScript files
    const jsCount = $("script[src]").length;

    // Count CSS files
    const cssCount = $('link[rel="stylesheet"], style').length;

    // Extract links and categorize them
    const baseUrl = new URL(url);
    const internalLinks: string[] = [];
    const externalLinks: string[] = [];

    $("a[href]").each((_, el) => {
      let href = $(el).attr("href") || "";

      // Skip empty, javascript, and anchor links
      if (!href || href.startsWith("javascript:") || href === "#") {
        return;
      }

      // Handle relative URLs
      if (href.startsWith("/")) {
        href = `${baseUrl.origin}${href}`;
      } else if (!href.startsWith("http://") && !href.startsWith("https://")) {
        // Handle relative URLs that don't start with a slash
        href = new URL(href, url).href;
      }

      try {
        const linkUrl = new URL(href);

        // Check if it's an internal or external link
        if (linkUrl.hostname === baseUrl.hostname) {
          if (!internalLinks.includes(href)) {
            internalLinks.push(href);
          }
        } else {
          if (!externalLinks.includes(href)) {
            externalLinks.push(href);
          }
        }
      } catch (e) {
        console.error(`Error parsing URL: ${href}`, e);
      }
    });

    // Determine redirect URL
    const redirectUrl =
      response.request?.res?.responseUrl !== url
        ? response.request?.res?.responseUrl
        : null;

    return {
      page_url: url,
      meta_title: metaTitle,
      meta_description: metaDescription,
      h1_tags: h1Tags,
      h2_tags: h2Tags,
      h3_tags: h3Tags,
      content_length: contentLength,
      open_graph: openGraph,
      twitter_card: twitterCard,
      canonical_url: canonicalUrl,
      http_status: response.status,
      is_indexable: isIndexable,
      has_noindex: hasNoindex,
      has_nofollow: hasNofollow,
      depth: depth,
      redirect_url: redirectUrl,
      content_type: response.headers["content-type"] || "",
      size_bytes: size,
      load_time_ms: loadTime,
      first_byte_time_ms: firstByteTime,
      structured_data: structuredData,
      images: images,
      js_count: jsCount,
      css_count: cssCount,
      internal_links: internalLinks,
      external_links: externalLinks,
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      // Handle specific Axios errors
      const status = error.response?.status || 0;
      const contentType = error.response?.headers["content-type"] || "";

      return {
        page_url: url,
        meta_title: "",
        meta_description: "",
        h1_tags: [],
        h2_tags: [],
        h3_tags: [],
        content_length: 0,
        open_graph: {},
        twitter_card: {},
        canonical_url: "",
        http_status: status,
        is_indexable: false,
        has_noindex: false,
        has_nofollow: false,
        depth: depth,
        redirect_url: null,
        content_type: contentType,
        size_bytes: 0,
        load_time_ms: 0,
        first_byte_time_ms: 0,
        structured_data: [],
        images: [],
        js_count: 0,
        css_count: 0,
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
