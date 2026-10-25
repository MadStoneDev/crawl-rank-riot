import express from "express";
import http from "http";
import { AddressInfo } from "net";
import v1Routes from "../../../src/routes/v1/index";

/**
 * Spin up just the /api/v1 surface on an ephemeral loopback port.
 *
 * This mirrors how src/app.ts mounts the v1 router (JSON body parsers, then
 * `app.use("/api/v1", v1Routes)`), but without importing app.ts — which would
 * bind the real port and start the crawl scheduler. The router carries all the
 * auth / scope / rate-limit / metering logic under test; only the mount is
 * replicated here.
 */
export interface TestServer {
  base: string;
  close(): Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));
  app.use("/api/v1", v1Routes);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A tiny typed fetch wrapper for hitting the v1 API in tests. */
export async function api(
  base: string,
  method: string,
  path: string,
  opts: { key?: string; body?: unknown; headerName?: "Authorization" | "X-API-Key" } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (opts.key) {
    if (opts.headerName === "X-API-Key") headers["X-API-Key"] = opts.key;
    else headers["Authorization"] = `Bearer ${opts.key}`;
  }
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let json: any = null;
  const text = await res.text();
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  return { status: res.status, json };
}
