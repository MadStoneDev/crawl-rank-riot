// tech_fingerprint extraction (Stage 4).
//
// Honest signals only: we match real asset URLs the page actually loaded
// (script_srcs + stylesheet_hrefs, captured by the parser in memory) and real
// external link hosts against a signature table. Nothing is guessed from
// anchor text or inferred. Platform/CMS reuses the crawler's existing
// detected_platform (browser.ts), with a small fallback for CMS bundles.
//
// Pure and dependency-free so it is unit-testable with ScanResult fixtures.

import type { ScanResult } from "../../types";

export interface TechFingerprint {
  /** CMS / site platform, e.g. "wordpress", "shopify" (crawler's detection). */
  platform: string | null;
  /** schema.org @type names present on the page (already extracted). */
  schema_types: string[];
  analytics: string[];
  booking: string[];
  crm_chat: string[];
  payments: string[];
  email_marketing: string[];
  frameworks: string[];
  libraries: string[];
}

interface Signature {
  name: string;
  category: Exclude<keyof TechFingerprint, "platform" | "schema_types">;
  /** Lowercase substrings; any match on a loaded asset URL / external host. */
  patterns: string[];
}

// Each entry maps a product to substrings that appear in the URLs of the
// assets a page loads (or its external links). Kept conservative to avoid
// false positives.
const SIGNATURES: Signature[] = [
  // Analytics
  { name: "Google Analytics", category: "analytics", patterns: ["google-analytics.com", "/gtag/js", "googletagmanager.com/gtag"] },
  { name: "Google Tag Manager", category: "analytics", patterns: ["googletagmanager.com/gtm.js", "googletagmanager.com/ns.html"] },
  { name: "Plausible", category: "analytics", patterns: ["plausible.io"] },
  { name: "Fathom", category: "analytics", patterns: ["usefathom.com"] },
  { name: "Matomo", category: "analytics", patterns: ["matomo.js", "/matomo/", "piwik.js"] },
  { name: "Hotjar", category: "analytics", patterns: ["hotjar.com", "static.hotjar"] },
  { name: "Microsoft Clarity", category: "analytics", patterns: ["clarity.ms"] },
  { name: "Meta Pixel", category: "analytics", patterns: ["connect.facebook.net", "fbevents.js"] },
  // Booking / scheduling
  { name: "Calendly", category: "booking", patterns: ["calendly.com"] },
  { name: "Acuity Scheduling", category: "booking", patterns: ["acuityscheduling.com"] },
  { name: "SimplyBook.me", category: "booking", patterns: ["simplybook.me"] },
  { name: "Setmore", category: "booking", patterns: ["setmore.com"] },
  // CRM / chat / support
  { name: "HubSpot", category: "crm_chat", patterns: ["hs-scripts.com", "hs-analytics.net", "hs-banner.com", "hubspot.com"] },
  { name: "Salesforce", category: "crm_chat", patterns: ["salesforce.com", "force.com", "pardot.com"] },
  { name: "Intercom", category: "crm_chat", patterns: ["intercom.io", "intercomcdn.com"] },
  { name: "Zendesk", category: "crm_chat", patterns: ["zendesk.com", "zdassets.com", "zopim.com"] },
  { name: "Drift", category: "crm_chat", patterns: ["drift.com", "driftt.com"] },
  { name: "Tawk.to", category: "crm_chat", patterns: ["tawk.to"] },
  { name: "LiveChat", category: "crm_chat", patterns: ["livechatinc.com"] },
  // Payments
  { name: "Stripe", category: "payments", patterns: ["js.stripe.com"] },
  { name: "PayPal", category: "payments", patterns: ["paypal.com/sdk", "paypalobjects.com", "paypal.com/js"] },
  { name: "Square", category: "payments", patterns: ["squareup.com", "squarecdn.com"] },
  // Email marketing
  { name: "Mailchimp", category: "email_marketing", patterns: ["mailchimp.com", "chimpstatic.com", "list-manage.com"] },
  { name: "Klaviyo", category: "email_marketing", patterns: ["klaviyo.com"] },
  { name: "ConvertKit", category: "email_marketing", patterns: ["convertkit.com", "ck.page"] },
  { name: "Constant Contact", category: "email_marketing", patterns: ["constantcontact.com"] },
  // Frameworks (from real bundle paths)
  { name: "Next.js", category: "frameworks", patterns: ["/_next/"] },
  { name: "Nuxt", category: "frameworks", patterns: ["/_nuxt/"] },
  { name: "Gatsby", category: "frameworks", patterns: ["/page-data/", "gatsby-"] },
  { name: "React", category: "frameworks", patterns: ["react-dom"] },
  // Libraries
  { name: "jQuery", category: "libraries", patterns: ["jquery"] },
  { name: "Bootstrap", category: "libraries", patterns: ["bootstrap"] },
  { name: "Tailwind", category: "libraries", patterns: ["tailwind"] },
];

// CMS bundle fallbacks when the crawler's header/HTML platform detection is
// empty (e.g. a WordPress site whose headers were generic).
const CMS_FALLBACK: Array<{ platform: string; patterns: string[] }> = [
  { platform: "wordpress", patterns: ["/wp-content/", "/wp-includes/"] },
  { platform: "shopify", patterns: ["cdn.shopify.com", "myshopify.com"] },
  { platform: "squarespace", patterns: ["squarespace.com", "sqsp.net"] },
  { platform: "wix", patterns: ["wixstatic.com", "parastorage.com"] },
];

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

/** Fingerprint one page's technology from its real loaded assets + links. */
export function fingerprintTech(result: ScanResult): TechFingerprint {
  const assetUrls = [
    ...(result.script_srcs ?? []),
    ...(result.stylesheet_hrefs ?? []),
    // Resource-hint script URLs count as real loaded assets (PC-08).
    ...(result.preload_hrefs ?? []),
  ].map((u) => u.toLowerCase());
  const externalHosts = (result.external_links ?? []).map((l) => hostOf(l.url));
  const haystack = [...assetUrls, ...externalHosts];

  const buckets: Record<Signature["category"], Set<string>> = {
    analytics: new Set(),
    booking: new Set(),
    crm_chat: new Set(),
    payments: new Set(),
    email_marketing: new Set(),
    frameworks: new Set(),
    libraries: new Set(),
  };

  for (const sig of SIGNATURES) {
    const hit = haystack.some((h) => sig.patterns.some((p) => h.includes(p)));
    if (hit) buckets[sig.category].add(sig.name);
  }

  // Inline analytics config is invisible to URL matching (consent managers,
  // Partytown, next/script, and inline gtag/dataLayer snippets). Scan inline
  // <script> bodies for GA4 / GTM signals too (PC-08).
  const inlineText = (result.inline_scripts ?? []).join("\n");
  if (inlineText) {
    const hasGa4 =
      /\bG-[A-Z0-9]{6,12}\b/.test(inlineText) ||
      /\bgtag\s*\(/.test(inlineText) ||
      /googletagmanager\.com\/gtag/i.test(inlineText) ||
      /google-analytics\.com\/(analytics|ga)\.js/i.test(inlineText) ||
      /\bga\s*\(\s*['"]create['"]/.test(inlineText);
    if (hasGa4) buckets.analytics.add("Google Analytics");
    const hasGtm =
      /\bGTM-[A-Z0-9]{4,}\b/.test(inlineText) ||
      /googletagmanager\.com\/gtm\.js/i.test(inlineText);
    if (hasGtm) buckets.analytics.add("Google Tag Manager");
  }

  let platform = result.detected_platform ?? null;
  if (!platform) {
    const match = CMS_FALLBACK.find((c) =>
      assetUrls.some((u) => c.patterns.some((p) => u.includes(p))),
    );
    platform = match?.platform ?? null;
  }

  const sorted = (s: Set<string>) => [...s].sort();
  return {
    platform,
    schema_types: [...(result.schema_types ?? [])],
    analytics: sorted(buckets.analytics),
    booking: sorted(buckets.booking),
    crm_chat: sorted(buckets.crm_chat),
    payments: sorted(buckets.payments),
    email_marketing: sorted(buckets.email_marketing),
    frameworks: sorted(buckets.frameworks),
    libraries: sorted(buckets.libraries),
  };
}

/** Merge per-page fingerprints into a site-level rollup (unions, deduped). */
export function rollupTech(fingerprints: TechFingerprint[]): TechFingerprint {
  const union = (key: Exclude<keyof TechFingerprint, "platform">) => {
    const s = new Set<string>();
    for (const f of fingerprints) for (const v of f[key] as string[]) s.add(v);
    return [...s].sort();
  };
  // Platform: the first non-null detected (they're almost always consistent).
  const platform = fingerprints.find((f) => f.platform)?.platform ?? null;
  return {
    platform,
    schema_types: union("schema_types"),
    analytics: union("analytics"),
    booking: union("booking"),
    crm_chat: union("crm_chat"),
    payments: union("payments"),
    email_marketing: union("email_marketing"),
    frameworks: union("frameworks"),
    libraries: union("libraries"),
  };
}
