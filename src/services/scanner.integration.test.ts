import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import { AddressInfo } from "net";
import { Scanner } from "./scanner";

/**
 * Fetch-layer integration tests (end-to-end over a real HTTP server).
 *
 * These exercise the full httpScan path — real socket, real redirect handling,
 * real charset re-decode, real content-type gate, real Link-header parsing —
 * against a local fixture server on 127.0.0.1. The production SSRF guard
 * (`isPublicUrl`) correctly refuses loopback, so we inject a permissive guard
 * *in the test only*. There is no env var or runtime flag that does this: the
 * Scanner's default guard is always the strict one (see ScannerDeps), and the
 * "default guard rejects loopback / private / link-local" test in
 * utils/url.test.ts proves it still refuses these hosts.
 *
 * The injected guard here allows only 127.0.0.1; everything else still goes
 * through the real guard, so a stray outbound request can't escape to the
 * public internet during the test.
 */

/** One fixture response, keyed by request path. */
interface Fixture {
  status?: number;
  headers?: Record<string, string>;
  /** Raw bytes so we can serve non-UTF-8 charsets faithfully. */
  body?: Buffer | string;
}

let server: http.Server;
let base: string;

// A paragraph of real body text so the fixtures read as content pages and the
// scanner keeps the HTTP result instead of escalating a thin shell to headless
// (which would need a real Chrome). Kept to ASCII so it survives latin1 bytes.
const BODY_TEXT =
  "<p>This bookkeeping practice helps small businesses keep their accounts " +
  "accurate, file on time, and understand their numbers. We reconcile bank " +
  "feeds, prepare activity statements, and advise on cash flow every month so " +
  "owners can focus on running the business rather than chasing paperwork.</p>";

const routes: Record<string, Fixture> = {
  // A plain UTF-8 HTML page.
  "/plain": {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "content-length": "" },
    body: "<!doctype html><html><head><title>Plain Page</title>" +
      '<meta name="description" content="hello world"></head>' +
      "<body><h1>Welcome</h1>" + BODY_TEXT + "</body></html>",
  },

  // windows-1252 body: 0x92 is a right single quote; naive UTF-8 decode mangles
  // it. decodeHtmlBody must honour the declared charset (P-07).
  "/win1252": {
    status: 200,
    headers: { "content-type": "text/html; charset=windows-1252" },
    body: Buffer.concat([
      Buffer.from("<!doctype html><html><head><title>It", "latin1"),
      Buffer.from([0x92]),
      Buffer.from("s here</title></head><body><h1>Caf", "latin1"),
      Buffer.from([0xe9]), // é in windows-1252
      Buffer.from("</h1>" + BODY_TEXT + "</body></html>", "latin1"),
    ]),
  },

  // A non-HTML resource that returns 200 — tracked but not parsed/scored (S-02).
  "/report.pdf": {
    status: 200,
    headers: { "content-type": "application/pdf" },
    body: "%PDF-1.4 not really a pdf",
  },

  // Canonical declared only in the HTTP Link header (CN-05).
  "/link-canonical": {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      link: '</link-canonical/>; rel="canonical"',
    },
    body: "<!doctype html><html><head><title>Header Canonical</title></head>" +
      "<body><h1>Hi</h1>" + BODY_TEXT + "</body></html>",
  },

  // Temporary (302) redirect to the real page — the hop status must be captured
  // so a temporary move isn't mistaken for a permanent one (R-01).
  "/temp-redirect": {
    status: 302,
    headers: { location: "/plain" },
    body: "",
  },
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const fixture = routes[req.url ?? ""];
    if (!fixture) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<title>Not found</title>");
      return;
    }
    const body =
      typeof fixture.body === "string"
        ? Buffer.from(fixture.body, "utf-8")
        : fixture.body ?? Buffer.alloc(0);
    const headers: Record<string, string> = { ...(fixture.headers ?? {}) };
    // Fill in a real Content-Length unless the fixture deliberately omitted one.
    if (!("content-length" in headers) || headers["content-length"] === "") {
      headers["content-length"] = String(body.byteLength);
    }
    res.writeHead(fixture.status ?? 200, headers);
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A Scanner whose guard permits only 127.0.0.1 (test-only). */
function localScanner(): Scanner {
  return new Scanner({
    urlGuard: async (url: string) => {
      try {
        return new URL(url).hostname === "127.0.0.1";
      } catch {
        return false;
      }
    },
  });
}

describe("httpScan fetch-layer integration (local fixture server)", () => {
  it("scans a plain UTF-8 HTML page end to end", async () => {
    const r = await localScanner().scan(`${base}/plain`, 0);
    expect(r.status).toBe(200);
    expect(r.scan_method).toBe("http");
    expect(r.title).toBe("Plain Page");
    expect(r.meta_description).toBe("hello world");
    expect(r.h1s).toContain("Welcome");
    expect(r.is_non_html).toBeFalsy();
  });

  it("re-decodes a windows-1252 body by its declared charset (P-07)", async () => {
    const r = await localScanner().scan(`${base}/win1252`, 0);
    expect(r.status).toBe(200);
    // 0x92 → U+2019, 0xE9 → é. A naive UTF-8 read would produce replacement chars.
    expect(r.title).toBe("It’s here");
    expect(r.h1s[0]).toBe("Café");
  });

  it("flags a non-HTML 200 resource without parsing it (S-02)", async () => {
    const r = await localScanner().scan(`${base}/report.pdf`, 0);
    expect(r.status).toBe(200);
    expect(r.is_non_html).toBe(true);
    expect(r.title).toBeFalsy();
  });

  it("captures a canonical declared in the HTTP Link header (CN-05)", async () => {
    const r = await localScanner().scan(`${base}/link-canonical`, 0);
    expect(r.canonical_url).toBe(`${base}/link-canonical/`);
  });

  it("records a temporary redirect hop with its 302 status (R-01)", async () => {
    const r = await localScanner().scan(`${base}/temp-redirect`, 0);
    expect(r.is_redirect).toBe(true);
    expect(r.redirect_hops?.[0]?.status).toBe(302);
    expect(r.status).toBe(200); // resolved to the final page
    expect(r.title).toBe("Plain Page");
  });

  it("refuses a host the injected guard does not allow (guard still enforced)", async () => {
    // The test guard only permits 127.0.0.1; a different host is blocked even
    // here, proving the guard is consulted on every scan rather than bypassed.
    const r = await localScanner().scan("http://10.0.0.1/plain", 0);
    expect(r.status).toBe(0);
    expect(r.errors?.[0]).toMatch(/private or reserved/i);
  });
});
