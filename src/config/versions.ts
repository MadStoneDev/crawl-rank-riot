// Stamped onto every scan so the app can tell results apart by the crawler and
// check logic that produced them (P0.6). Bump CRAWLER_VERSION when crawl/parse
// behaviour changes, CHECK_VERSION when issue-detection rules change.
//
// Date-based (YYYY.MM.DD) so ordering is obvious. 2026.10.02 fixed the P0 parsing
// bugs (entity decoding, alt="", canonical, bot-blocked links). 2026.10.03 adds
// the P0 follow-ups (OG/srcset decoding, canonicalised-variant handling, link
// error reasons) and P1.2 severity-capped scoring. Any scan with an older/null
// version predates these and the app should offer a rescan.
export const CRAWLER_VERSION = "2026.10.03";
export const CHECK_VERSION = "2026.10.03";
