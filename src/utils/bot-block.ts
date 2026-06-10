import { getUserAgent, getEgressIp } from "../config/identity";

// Shape written into scans.summary_stats.bot_protection and read by the
// frontend's BotBlockedNotice to show allowlist instructions.
export interface BotProtectionInfo {
  blocked: true;
  blocked_pages: number;
  total_pages: number;
  user_agent: string;
  egress_ip: string | null;
}

export interface BotBlockSignal {
  /** Pages scanned successfully (already excludes blocked pages) */
  pagesScanned: number;
  /** Pages dropped because they were a bot-protection challenge */
  blockedCount: number;
  /** Whether the homepage / seed URL itself was blocked */
  homepageBlocked: boolean;
  /** A sample "Blocked by bot protection ... (blocked IP x)" error, if any */
  sampleError?: string;
}

/**
 * Decide whether a scan was effectively blocked by a host firewall / WAF, and
 * build the signal to store. Returns null when the scan ran normally.
 *
 * Note: blocked pages are dropped from the crawl results, so this works off the
 * crawler's separate block counters rather than the scan results.
 *
 * Treated as blocked when the homepage itself was challenged, or when blocked
 * pages were at least half of everything we attempted.
 */
export function detectBotBlock(signal: BotBlockSignal): BotProtectionInfo | null {
  const { pagesScanned, blockedCount, homepageBlocked, sampleError } = signal;
  if (blockedCount === 0) return null;

  const attempted = pagesScanned + blockedCount;
  if (!homepageBlocked && blockedCount / attempted < 0.5) {
    return null;
  }

  // Prefer the IP embedded in the challenge (most accurate), else the
  // configured egress IP
  let egressIp: string | null = getEgressIp();
  const ipMatch = sampleError?.match(/blocked IP (\d{1,3}(?:\.\d{1,3}){3})/i);
  if (ipMatch) egressIp = ipMatch[1];

  return {
    blocked: true,
    blocked_pages: blockedCount,
    total_pages: attempted,
    user_agent: getUserAgent(),
    egress_ip: egressIp,
  };
}
