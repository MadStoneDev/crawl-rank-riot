import { describe, it, expect } from "vitest";
import { extractBusinessInfo, hasBusinessFacts } from "./business-info";
import type { ScanResult } from "../../types";

function page(over: Partial<ScanResult>): ScanResult {
  return {
    url: "https://acme.test/contact",
    status: 200,
    depth: 0,
    h1s: [], h2s: [], h3s: [], h4s: [], h5s: [], h6s: [],
    content_length: 0, word_count: 0,
    canonical_url: null, is_indexable: true,
    has_robots_noindex: false, has_robots_nofollow: false,
    open_graph: {}, twitter_card: {},
    internal_links: [], external_links: [], images: [],
    redirect_url: null, content_type: "text/html", size_bytes: 0,
    load_time_ms: 0, first_byte_time_ms: 0,
    structured_data: [], schema_types: [],
    js_count: 0, css_count: 0, keywords: [], scanned_at: "",
    ...over,
  };
}

describe("extractBusinessInfo (Stage 4)", () => {
  it("pulls NAP, hours, service areas and socials from LocalBusiness JSON-LD", () => {
    const info = extractBusinessInfo(page({
      structured_data: [
        {
          "@context": "https://schema.org",
          "@type": "LocalBusiness",
          name: "Acme Bookkeeping",
          telephone: "+61 2 1234 5678",
          email: "mailto:hi@acme.test",
          address: {
            "@type": "PostalAddress",
            streetAddress: "1 Main St",
            addressLocality: "Sydney",
            addressRegion: "NSW",
            postalCode: "2000",
            addressCountry: { "@type": "Country", name: "AU" },
          },
          openingHoursSpecification: [
            { "@type": "OpeningHoursSpecification", dayOfWeek: ["Monday", "Tuesday"], opens: "09:00", closes: "17:00" },
          ],
          areaServed: [{ "@type": "City", name: "Sydney" }, "Greater Sydney"],
          sameAs: ["https://facebook.com/acme", "https://www.linkedin.com/company/acme"],
        },
      ],
    }));
    expect(info.name).toBe("Acme Bookkeeping");
    expect(info.phones).toEqual(["+61 2 1234 5678"]);
    expect(info.emails).toEqual(["hi@acme.test"]);
    expect(info.address).toEqual({
      street: "1 Main St", locality: "Sydney", region: "NSW", postal_code: "2000", country: "AU",
    });
    expect(info.opening_hours).toEqual(["Monday, Tuesday 09:00-17:00"]);
    expect(info.service_areas).toEqual(["Sydney", "Greater Sydney"]);
    expect(info.socials).toEqual([
      { platform: "facebook", url: "https://facebook.com/acme" },
      { platform: "linkedin", url: "https://www.linkedin.com/company/acme" },
    ]);
    expect(info.source_url).toBe("https://acme.test/contact");
  });

  it("unwraps @graph and merges contact links + external socials", () => {
    const info = extractBusinessInfo(page({
      structured_data: [
        { "@context": "https://schema.org", "@graph": [{ "@type": "Organization", name: "Acme" }] },
      ],
      contact_links: [
        { type: "tel", value: "0400 000 000", href: "tel:0400000000" },
        { type: "email", value: "sales@acme.test", href: "mailto:sales@acme.test" },
      ],
      external_links: [
        { url: "https://instagram.com/acme", anchor_text: "IG", rel_attributes: [] },
        { url: "https://example.com/not-social", anchor_text: "x", rel_attributes: [] },
      ],
    }));
    expect(info.name).toBe("Acme");
    expect(info.phones).toEqual(["0400 000 000"]);
    expect(info.emails).toEqual(["sales@acme.test"]);
    expect(info.socials).toEqual([{ platform: "instagram", url: "https://instagram.com/acme" }]);
  });

  it("falls back to og:site_name for the name and reports no facts on a bare page", () => {
    expect(extractBusinessInfo(page({ open_graph: { "og:site_name": "Acme Co" } })).name).toBe("Acme Co");
    const bare = extractBusinessInfo(page({}));
    expect(hasBusinessFacts(bare)).toBe(false);
  });

  it("accepts a plain-string address as raw", () => {
    const info = extractBusinessInfo(page({
      structured_data: [{ "@type": "LocalBusiness", address: "1 Main St, Sydney NSW 2000" }],
    }));
    expect(info.address).toEqual({ raw: "1 Main St, Sydney NSW 2000" });
  });
});
