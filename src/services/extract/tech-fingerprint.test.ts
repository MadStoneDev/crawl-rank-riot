import { describe, it, expect } from "vitest";
import { fingerprintTech, rollupTech } from "./tech-fingerprint";
import type { ScanResult } from "../../types";

function page(over: Partial<ScanResult>): ScanResult {
  return {
    url: "https://example.com/",
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

describe("fingerprintTech (Stage 4)", () => {
  it("detects analytics from real asset URLs", () => {
    const fp = fingerprintTech(page({
      script_srcs: [
        "https://www.googletagmanager.com/gtag/js?id=G-XX",
        "https://plausible.io/js/script.js",
      ],
    }));
    expect(fp.analytics).toEqual(["Google Analytics", "Plausible"]);
  });

  it("detects booking, CRM/chat, payments and email-marketing tools", () => {
    const fp = fingerprintTech(page({
      script_srcs: [
        "https://assets.calendly.com/assets/external/widget.js",
        "https://js.stripe.com/v3/",
        "https://js.hs-scripts.com/123.js",
      ],
      external_links: [
        { url: "https://mailchimp.com/x", anchor_text: "", rel_attributes: [] },
      ],
    }));
    expect(fp.booking).toEqual(["Calendly"]);
    expect(fp.payments).toEqual(["Stripe"]);
    expect(fp.crm_chat).toEqual(["HubSpot"]);
    expect(fp.email_marketing).toEqual(["Mailchimp"]);
  });

  it("uses the crawler's detected_platform, else a CMS bundle fallback", () => {
    expect(fingerprintTech(page({ detected_platform: "shopify" })).platform).toBe("shopify");
    const wp = fingerprintTech(page({
      script_srcs: ["https://example.com/wp-content/themes/x/app.js"],
    }));
    expect(wp.platform).toBe("wordpress");
  });

  it("passes schema types through and reports nothing on a bare page", () => {
    const fp = fingerprintTech(page({ schema_types: ["Organization"] }));
    expect(fp.schema_types).toEqual(["Organization"]);
    expect(fp.analytics).toEqual([]);
    expect(fp.payments).toEqual([]);
    expect(fp.frameworks).toEqual([]);
  });

  it("detects frameworks from bundle paths", () => {
    const fp = fingerprintTech(page({ script_srcs: ["https://example.com/_next/static/chunk.js"] }));
    expect(fp.frameworks).toEqual(["Next.js"]);
  });

  it("rolls up per-page fingerprints into a deduped union", () => {
    const a = fingerprintTech(page({ detected_platform: "wordpress", script_srcs: ["https://js.stripe.com/v3/"] }));
    const b = fingerprintTech(page({ script_srcs: ["https://plausible.io/js/script.js"] }));
    const roll = rollupTech([a, b]);
    expect(roll.platform).toBe("wordpress");
    expect(roll.payments).toEqual(["Stripe"]);
    expect(roll.analytics).toEqual(["Plausible"]);
  });

  it("detects inline GA4 and GTM config a URL-only scan would miss (PC-08)", () => {
    const fp = fingerprintTech(page({
      inline_scripts: [
        "window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('consent','default',{});gtag('config','G-8TL2E4F9CH');",
        "(function(w,d,s,l,i){})(window,document,'script','dataLayer','GTM-K6S8KCK5');",
      ],
    }));
    expect(fp.analytics).toEqual(["Google Analytics", "Google Tag Manager"]);
  });

  it("detects analytics preloaded via a resource hint (PC-08)", () => {
    const fp = fingerprintTech(page({
      preload_hrefs: [
        "https://www.googletagmanager.com/gtm.js?id=GTM-K6S8KCK5",
        "https://www.googletagmanager.com/gtag/js?id=G-8TL2E4F9CH",
      ],
    }));
    expect(fp.analytics).toEqual(["Google Analytics", "Google Tag Manager"]);
  });

  it("does not flag analytics on inline scripts without analytics (PC-08)", () => {
    const fp = fingerprintTech(page({ inline_scripts: ["console.log('hello');const x=1;"] }));
    expect(fp.analytics).toEqual([]);
  });
});
