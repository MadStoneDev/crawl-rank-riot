import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { extractFromHtml, applyParsedHtml, decodeHtmlBody, type ParsedHtml } from "./parse-html";
import type { ScanResult } from "../../types";

/**
 * Guards the single shared parser→ScanResult mapping (applyParsedHtml), which
 * BOTH scan routes use (HTTP via extractFromHtml(serverHtml), headless via
 * extractFromHtml(page.content())). If extractFromHtml gains a field but
 * applyParsedHtml forgets to carry it, this test fails — so a field can no
 * longer be populated on one route and dropped on the other (the PC-08 class of
 * bug, which also silently dropped main_text and contact_links from every scan).
 */

// Parser fields that are inputs to a derived ScanResult field rather than copied
// one-to-one. meta_noindex/meta_nofollow are merged into has_robots_* (and
// is_indexable); everything else must land on a field of the same name.
const REMAPPED: Record<string, keyof ScanResult> = {
  meta_noindex: "has_robots_noindex",
  meta_nofollow: "has_robots_nofollow",
};

/** A bare result as the scanner would start one, with url+status set (both
 *  routes set these from the transport layer before mapping). */
function baseResult(url: string): ScanResult {
  return { url, status: 200 } as unknown as ScanResult;
}

function assertEveryParserFieldMapped(parsed: ParsedHtml, result: ScanResult) {
  const missing: string[] = [];
  for (const key of Object.keys(parsed) as Array<keyof ParsedHtml>) {
    if (parsed[key] === undefined) continue;
    const target = (REMAPPED[key as string] ?? key) as keyof ScanResult;
    if (result[target] === undefined) missing.push(String(key));
  }
  expect(missing).toEqual([]);
}

describe("applyParsedHtml — shared field mapping (both routes)", () => {
  it("carries every field extractFromHtml produces for a real page (ravenci golden)", () => {
    const dir = join(__dirname, "__fixtures__", "before-after");
    const bytes = readFileSync(join(dir, "nextjs-ravenci-home.html"));
    const html = decodeHtmlBody(new Uint8Array(bytes), "text/html; charset=utf-8");
    const url = "https://ravenci.solutions/";

    const parsed = extractFromHtml(html, url);
    const result = baseResult(url);
    applyParsedHtml(result, parsed);

    assertEveryParserFieldMapped(parsed, result);

    // The two fields the old per-route mapping dropped on EVERY scan.
    expect(result.main_text).toBeDefined();
    expect((result.main_text ?? "").length).toBeGreaterThan(0);
    // Derived fields the mapping owns.
    expect(result.is_indexable).toBe(!result.has_robots_noindex);
    expect(result.canonical_is_self).toBeDefined();
    expect(result.soft_404).toBe(false);
  });

  it("maps the fields the old HTTP path silently dropped (main_text, contact_links)", () => {
    const url = "https://acme.test/contact";
    const html = `<!doctype html><html lang="en"><head>
      <title>Contact Acme</title>
      <link rel="canonical" href="https://acme.test/contact"/>
      <link rel="preload" as="script" href="https://www.googletagmanager.com/gtag/js?id=G-ABC123"/>
      <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('config','G-ABC123');</script>
      </head><body>
      <h1>Contact Acme</h1>
      <p>Acme Bookkeeping helps small businesses in Sydney keep their accounts accurate and file on time. Call us or drop into the office on Main St during business hours.</p>
      <a href="tel:+61299990000">Call us</a>
      <a href="mailto:hi@acme.test">Email us</a>
      </body></html>`;

    const result = baseResult(url);
    applyParsedHtml(result, extractFromHtml(html, url));

    // main_text: feeds the Stage 4 api_job_pages snapshot — was always empty.
    expect((result.main_text ?? "")).toContain("Acme Bookkeeping");
    // contact_links: feeds business_info — tel/mailto were dropped on scans.
    const kinds = (result.contact_links ?? []).map((c) => c.type).sort();
    expect(kinds).toEqual(["email", "tel"]);
    // Inline + preloaded analytics signals (PC-08) carried.
    expect((result.inline_scripts ?? []).length).toBeGreaterThan(0);
    expect(result.preload_hrefs ?? []).toContain(
      "https://www.googletagmanager.com/gtag/js?id=G-ABC123",
    );
    expect(result.canonical_url).toBe("https://acme.test/contact");
    expect(result.soft_404).toBe(false);
  });
});
