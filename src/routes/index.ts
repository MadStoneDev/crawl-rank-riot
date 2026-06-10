import { Router } from "express";
import scanRouter from "./scan"; // Make sure this path is correct
import { authMiddleware } from "../middleware/auth";
import { isPublicUrl } from "../utils/url";
import { USER_AGENT } from "../config/identity";

const router = Router();

// Health check route (no auth required)
router.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "2.0.0",
  });
});

// Connectivity diagnostic — requires DEBUG_FETCH_TOKEN; disabled when the env var is unset
router.get("/debug/fetch", async (req, res) => {
  const debugToken = process.env.DEBUG_FETCH_TOKEN;
  if (!debugToken || req.headers["x-debug-token"] !== debugToken) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const url = req.query.url as string;
  if (!url) {
    res.status(400).json({ error: "url query param required" });
    return;
  }

  if (!(await isPublicUrl(url))) {
    res.status(400).json({ error: "URL does not resolve to a public address" });
    return;
  }

  const steps: Array<{ step: string; ok: boolean; ms: number; detail?: string }> = [];

  // Step 1: DNS resolution
  try {
    const dns = await import("dns").then(m => m.promises);
    const hostname = new URL(url).hostname;
    const t0 = Date.now();
    const addresses = await dns.resolve(hostname);
    steps.push({ step: "dns", ok: true, ms: Date.now() - t0, detail: addresses.join(", ") });
  } catch (e: any) {
    steps.push({ step: "dns", ok: false, ms: 0, detail: e.message });
    res.json({ url, steps });
    return;
  }

  // Step 2: HTTP fetch (headers only)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const t0 = Date.now();
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Encoding": "gzip, deflate",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    const headerTime = Date.now() - t0;
    const body = await resp.text();
    clearTimeout(timeout);
    const totalTime = Date.now() - t0;

    steps.push({
      step: "fetch",
      ok: resp.ok,
      ms: totalTime,
      detail: `status=${resp.status}, headers=${headerTime}ms, body=${body.length} bytes, title=${(body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || "").slice(0, 100)}`,
    });
  } catch (e: any) {
    const cause = e.cause ? `${e.cause.code || e.cause.name || ""} ${e.cause.message || ""}`.trim() : null;
    steps.push({ step: "fetch", ok: false, ms: 0, detail: cause || e.message });
  }

  res.json({ url, steps });
});

// Scan routes (protected by JWT auth)
router.use("/", authMiddleware, scanRouter);

export default router;
