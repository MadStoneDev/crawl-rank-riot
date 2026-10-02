// Stamped onto every scan so the app can tell results apart by the crawler and
// check logic that produced them (P0.6). Bump CRAWLER_VERSION when crawl/parse
// behaviour changes, CHECK_VERSION when issue-detection rules change.
//
// Date-based (YYYY.MM.DD) so ordering is obvious. 2026.10.02 is the release that
// fixed the P0 parsing bugs (entity decoding, alt="", canonical, bot-blocked
// links); any scan with an older/null version predates those fixes and the app
// should offer a rescan.
export const CRAWLER_VERSION = "2026.10.02";
export const CHECK_VERSION = "2026.10.02";
