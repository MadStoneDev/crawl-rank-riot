/**
 * Main entry point for the crawler service
 * Exports the public API for the crawler
 */

import { Crawler, CrawlOptions } from "./core/crawler";
import { HttpScanner } from "./scanners/http";
import { HeadlessBrowser } from "./scanners/browser";
import { RobotsParser } from "./processors/robots";
import { SitemapProcessor } from "./processors/sitemap";
import { UrlProcessor } from "./utils/url";
import {
  extractVisibleText,
  extractKeywords,
  calculateReadingTime,
} from "./processors/content";

import { ScanResult } from "../../types/common";

/**
 * Main crawler function that crawls a website
 * @param url URL to crawl
 * @param options Crawl options
 * @param scanId Scan ID for tracking
 * @param projectId Project ID for tracking
 * @returns Array of scan results
 */
export async function crawlWebsite(
  url: string,
  options: CrawlOptions = {},
  scanId?: string,
  projectId?: string,
): Promise<ScanResult[]> {
  // Initialize a crawler with the given options
  const crawler = new Crawler({ scanId, projectId });

  console.log("00. Pre crawler");
  // Execute the crawl
  return crawler.crawlWebsite(url, options);
}

// Export the crawler components
export {
  // Core components
  Crawler,

  // Scanners
  HttpScanner,
  HeadlessBrowser,

  // Processors
  RobotsParser,
  SitemapProcessor,

  // Utilities
  UrlProcessor,
  extractVisibleText,
  extractKeywords,
  calculateReadingTime,

  // Types
  type CrawlOptions,
  type ScanResult,
};
