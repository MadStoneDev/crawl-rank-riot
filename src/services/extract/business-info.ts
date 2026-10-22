// business_info extraction (Stage 4).
//
// Pulls business facts that are actually present on the page: NAP (name,
// phone, address), opening hours, service areas and social profiles. Sources,
// in priority order: Organization/LocalBusiness JSON-LD (the richest, already
// stored in structured_data), tel:/mailto: links (contact_links), og:site_name,
// and social profile hosts in external_links. Nothing is invented; every fact
// is tied to the page it was found on (source_url).
//
// Pure and dependency-free so it is unit-testable with ScanResult fixtures.

import type { ScanResult } from "../../types";

export interface BusinessAddress {
  street?: string;
  locality?: string;
  region?: string;
  postal_code?: string;
  country?: string;
  /** Present when the address was a plain string, not a structured PostalAddress. */
  raw?: string;
}

export interface BusinessSocial {
  platform: string;
  url: string;
}

export interface BusinessInfo {
  /** The page these facts were found on. */
  source_url: string;
  name: string | null;
  phones: string[];
  emails: string[];
  address: BusinessAddress | null;
  opening_hours: string[];
  service_areas: string[];
  socials: BusinessSocial[];
}

const SOCIAL_DOMAINS: Record<string, string> = {
  "facebook.com": "facebook",
  "fb.com": "facebook",
  "instagram.com": "instagram",
  "linkedin.com": "linkedin",
  "twitter.com": "twitter",
  "x.com": "twitter",
  "youtube.com": "youtube",
  "youtu.be": "youtube",
  "tiktok.com": "tiktok",
  "pinterest.com": "pinterest",
};

function socialPlatform(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).host.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  for (const [domain, platform] of Object.entries(SOCIAL_DOMAINS)) {
    if (host === domain || host.endsWith(`.${domain}`)) return platform;
  }
  return null;
}

/** Flatten JSON-LD: unwrap top-level arrays and { @graph: [...] } wrappers. */
function flattenJsonLd(blocks: unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      if (Array.isArray(obj["@graph"])) (obj["@graph"] as unknown[]).forEach(visit);
      out.push(obj);
    }
  };
  for (const b of blocks ?? []) visit(b);
  return out;
}

function typesOf(node: Record<string, unknown>): string[] {
  const t = node["@type"];
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  return [];
}

const ORG_TYPES = new Set(["Organization", "LocalBusiness", "Corporation", "Store", "NGO"]);
function isOrgType(node: Record<string, unknown>): boolean {
  return typesOf(node).some(
    (t) => ORG_TYPES.has(t) || /business|organization|store|professionalservice/i.test(t),
  );
}

function asStringArray(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}

function parseAddress(v: unknown): BusinessAddress | null {
  if (typeof v === "string") return { raw: v };
  if (v && typeof v === "object") {
    const a = v as Record<string, unknown>;
    const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : undefined);
    const countryRaw = a["addressCountry"];
    const country =
      typeof countryRaw === "string"
        ? countryRaw
        : countryRaw && typeof countryRaw === "object"
          ? (((countryRaw as Record<string, unknown>)["name"] as string) ?? undefined)
          : undefined;
    const addr: BusinessAddress = {
      street: str("streetAddress"),
      locality: str("addressLocality"),
      region: str("addressRegion"),
      postal_code: str("postalCode"),
      country,
    };
    return Object.values(addr).some((x) => x) ? addr : null;
  }
  return null;
}

function parseOpeningHours(node: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const h of asStringArray(node["openingHours"])) out.push(h);
  const spec = node["openingHoursSpecification"];
  const specs = Array.isArray(spec) ? spec : spec ? [spec] : [];
  for (const s of specs) {
    if (!s || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    const days = asStringArray(o["dayOfWeek"]).map((d) => d.replace(/^https?:\/\/schema\.org\//, ""));
    const opens = typeof o["opens"] === "string" ? (o["opens"] as string) : "";
    const closes = typeof o["closes"] === "string" ? (o["closes"] as string) : "";
    const label = `${days.join(", ")} ${opens}-${closes}`.trim();
    if (label && label !== "-") out.push(label);
  }
  return out;
}

function parseServiceAreas(v: unknown): string[] {
  const items = Array.isArray(v) ? v : v !== undefined ? [v] : [];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item === "string") out.push(item);
    else if (item && typeof item === "object") {
      const name = (item as Record<string, unknown>)["name"];
      if (typeof name === "string") out.push(name);
    }
  }
  return out;
}

const uniq = (arr: string[]) => [...new Set(arr.map((s) => s.trim()).filter(Boolean))];

/** Extract business facts found on one page. */
export function extractBusinessInfo(result: ScanResult): BusinessInfo {
  const phones: string[] = [];
  const emails: string[] = [];
  const openingHours: string[] = [];
  const serviceAreas: string[] = [];
  const socialsByUrl = new Map<string, BusinessSocial>();
  let name: string | null = null;
  let address: BusinessAddress | null = null;

  const addSocial = (url: string) => {
    const platform = socialPlatform(url);
    if (platform && !socialsByUrl.has(url)) socialsByUrl.set(url, { platform, url });
  };

  // 1. JSON-LD Organization / LocalBusiness nodes (richest source).
  for (const node of flattenJsonLd(result.structured_data ?? [])) {
    if (!isOrgType(node)) continue;
    if (!name && typeof node["name"] === "string") name = node["name"] as string;
    for (const p of asStringArray(node["telephone"])) phones.push(p);
    for (const e of asStringArray(node["email"])) emails.push(e.replace(/^mailto:/i, ""));
    if (!address) address = parseAddress(node["address"]);
    openingHours.push(...parseOpeningHours(node));
    serviceAreas.push(...parseServiceAreas(node["areaServed"]));
    for (const s of asStringArray(node["sameAs"])) addSocial(s);
  }

  // 2. Contact links captured from tel:/mailto: hrefs.
  for (const c of result.contact_links ?? []) {
    if (c.type === "tel") phones.push(c.value);
    else emails.push(c.value);
  }

  // 3. Social profiles from external links.
  for (const link of result.external_links ?? []) addSocial(link.url);

  // 4. Name fallback: og:site_name.
  if (!name && typeof result.open_graph?.["og:site_name"] === "string") {
    name = result.open_graph["og:site_name"];
  }

  return {
    source_url: result.url,
    name,
    phones: uniq(phones),
    emails: uniq(emails),
    address,
    opening_hours: uniq(openingHours),
    service_areas: uniq(serviceAreas),
    socials: [...socialsByUrl.values()],
  };
}

/** True when a page yielded any business fact worth returning. */
export function hasBusinessFacts(info: BusinessInfo): boolean {
  return !!(
    info.name ||
    info.phones.length ||
    info.emails.length ||
    info.address ||
    info.opening_hours.length ||
    info.service_areas.length ||
    info.socials.length
  );
}
