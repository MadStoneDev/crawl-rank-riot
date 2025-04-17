import axios from "axios";
import * as cheerio from "cheerio";

interface ScanResult {
  words: string[];
  images: string[];
  links: string[];
}

export async function scanWebsite(url: string): Promise<ScanResult> {
  try {
    // Ensure URL has proper protocol
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = "https://" + url;
    }

    // Fetch the website content
    const response = await axios.get(url);
    const html = response.data;

    // Load the HTML into cheerio
    const $ = cheerio.load(html);

    // Extract text content from relevant tags and split into words
    const textContent = $(
      "p, h1, h2, h3, h4, h5, h6, span, div, li, td, th, label, button",
    )
      .map(function () {
        return $(this).text().trim();
      })
      .get()
      .join(" ");

    // Split into words, filter out empty strings and clean up words
    const words = textContent
      .split(/\s+/)
      .map((word) => word.toLowerCase().replace(/[^\w\s]/g, ""))
      .filter((word) => word.length > 0);

    // Extract image sources
    const images = $("img")
      .map(function () {
        return $(this).attr("src") || "";
      })
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

    // Extract link hrefs
    const links = $("a")
      .map(function () {
        return $(this).attr("href") || "";
      })
      .get()
      .filter((href) => href.length > 0 && !href.startsWith("#"))
      .map((href) => {
        // Handle relative URLs
        if (href.startsWith("/")) {
          const baseUrl = new URL(url);
          return `${baseUrl.origin}${href}`;
        }
        return href;
      });

    return {
      words,
      images,
      links,
    };
  } catch (error) {
    console.error(`Error scanning website ${url}:`, error);
    throw new Error(
      `Failed to scan website: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
