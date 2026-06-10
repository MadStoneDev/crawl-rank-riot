import dotenv from "dotenv";

// Ensure env vars are available even if this module is imported before config
dotenv.config();

// Single source of truth for the crawler's public identity. Surfaced to site
// owners so they can recognise and allowlist RankRiot instead of us needing a
// proxy. Keep these in sync with the allowlist instructions shown in the
// frontend (BotBlockedNotice).

export const BOT_NAME = "RankRiotBot";
export const BOT_VERSION = "1.0";
export const BOT_INFO_URL = "https://rankriot.app/bot";

// Default user agent: a real Chrome signature with an appended identification
// token. The browser signature keeps us working on sites that block unknown
// bots by default, while the "compatible; RankRiotBot" token lets cooperative
// site owners allowlist us by name and recognise us in their logs.
// Override entirely with CRAWLER_USER_AGENT (e.g. set a pure-bot UA, or revert
// to a plain browser UA) without a redeploy.
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 " +
  `(compatible; ${BOT_NAME}/${BOT_VERSION}; +${BOT_INFO_URL})`;

export function getUserAgent(): string {
  return process.env.CRAWLER_USER_AGENT || DEFAULT_USER_AGENT;
}

// The crawler's outbound IP, shown to customers so they can allowlist by IP
// (more reliable than UA). Set CRAWLER_EGRESS_IP on the server; null when
// unknown (the frontend then falls back to UA-only instructions).
export function getEgressIp(): string | null {
  return process.env.CRAWLER_EGRESS_IP || null;
}

// Convenience constant for the many call sites that just need the UA string.
export const USER_AGENT = getUserAgent();
