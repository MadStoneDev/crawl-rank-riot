import { ScanResult } from "../../../types/common";
import { extractKeywords } from "../processors/content";
import { UrlProcessor } from "./url";

/**
 * Transforms the crawler raw result to match the expected ScanResult interface
 * This helps normalize output from different scanners to a consistent format
 * @param result Raw scanner result
 * @param baseUrl Base URL for resolving relative URLs
 * @returns Normalized scan result
 */
export function adaptCrawlerResult(result: any, baseUrl: string): ScanResult {
  const urlProcessor = new UrlProcessor(baseUrl);

  // Extract content from result
  const visibleContent = result.content || "";
  const wordCount = visibleContent
    .split(/\s+/)
    .filter((word: string) => word.length > 0).length;

  // Transform links
  const internalLinks = result.internal_links.map((link: any) => ({
    url: link.url,
    anchor_text: link.text || "",
    rel_attributes: link.rel_attributes || [],
  }));

  const externalLinks = result.external_links.map((link: any) => ({
    url: link.url,
    anchor_text: link.text || "",
    rel_attributes: link.rel_attributes || [],
  }));

  // Transform images
  const images =
    result.images?.map((img: any) => ({
      src: img.url || img.src || "",
      alt: img.alt || "",
    })) || [];

  // Extract headings
  const h1s = Array.isArray(result.h1s)
    ? result.h1s
    : result.h1
      ? [result.h1]
      : [];
  const h2s = Array.isArray(result.h2s) ? result.h2s : [];
  const h3s = Array.isArray(result.h3s) ? result.h3s : [];
  const h4s = Array.isArray(result.h4s) ? result.h4s : [];
  const h5s = Array.isArray(result.h5s) ? result.h5s : [];
  const h6s = Array.isArray(result.h6s) ? result.h6s : [];

  // Extract meta tags
  const openGraph = result.open_graph || {};
  const twitterCard = result.twitter_card || {};

  // Transform to expected format
  return {
    url: result.url,
    title: result.title || "",
    meta_description: result.meta_description || "",
    h1s,
    h2s,
    h3s,
    h4s,
    h5s,
    h6s,
    content_length: visibleContent.length,
    word_count: wordCount,
    open_graph: openGraph,
    twitter_card: twitterCard,
    canonical_url: result.canonical_url || null,
    status: result.status || 0, // Fixed: was http_status
    is_indexable:
      result.is_indexable !== undefined ? result.is_indexable : true,
    has_robots_noindex: result.has_robots_noindex || false,
    has_robots_nofollow: result.has_robots_nofollow || false,
    depth: result.depth,
    redirect_url: result.is_redirect ? result.url : null,
    redirected_from: result.redirected_from || null,
    content_type: result.content_type || "",
    size_bytes: result.size_bytes || 0,
    load_time_ms: result.load_time_ms || 0,
    first_byte_time_ms: result.first_byte_time_ms || 0,
    structured_data: result.structured_data || [],
    schema_types: result.schema_types || [],
    images,
    js_count: result.js_count || 0,
    css_count: result.css_count || 0,
    keywords: result.keywords || extractKeywords(visibleContent),
    internal_links: internalLinks, // Fixed: was just "internal_links"
    external_links: externalLinks, // Fixed: was just "external_links"
    scan_method: result.scan_method || "unknown",
    scanned_at: result.scanned_at || new Date().toISOString(),
    errors: result.errors || [],
    warnings: result.warnings || [],
  };
}
