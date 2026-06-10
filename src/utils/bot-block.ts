import { ScanResult } from "../types";
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

const BLOCK_MARKER = "Blocked by bot protection";

function isBlocked(result: ScanResult): boolean {
  return (result.errors || []).some((e) => e.includes(BLOCK_MARKER));
}

/**
 * Decide whether a scan was effectively blocked by a host firewall / WAF.
 * Returns the signal to store, or null when the scan ran normally.
 *
 * Treated as blocked when the homepage itself was challenged, or when at least
 * half of the crawled pages were — either way the results are unusable and the
 * customer needs to allowlist us.
 */
export function detectBotBlock(
  scanResults: ScanResult[],
): BotProtectionInfo | null {
  if (scanResults.length === 0) return null;

  const homepage =
    scanResults.find((r) => r.depth === 0) || scanResults[0];
  const blockedPages = scanResults.filter(isBlocked).length;
  const homepageBlocked = isBlocked(homepage);

  if (!homepageBlocked && blockedPages / scanResults.length < 0.5) {
    return null;
  }

  // Prefer an IP recovered from the challenge page itself (the most accurate),
  // falling back to the configured egress IP
  let egressIp: string | null = getEgressIp();
  for (const r of scanResults) {
    for (const e of r.errors || []) {
      const m = e.match(/blocked IP (\d{1,3}(?:\.\d{1,3}){3})/i);
      if (m) {
        egressIp = m[1];
        break;
      }
    }
    if (egressIp && egressIp !== getEgressIp()) break;
  }

  return {
    blocked: true,
    blocked_pages: blockedPages,
    total_pages: scanResults.length,
    user_agent: getUserAgent(),
    egress_ip: egressIp,
  };
}
