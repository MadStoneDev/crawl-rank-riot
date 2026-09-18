import { Agent, ProxyAgent } from "undici";
import { webBotAuthHeaders } from "./web-bot-auth";

let proxyAgent: ProxyAgent | null = null;
let insecureProxyAgent: ProxyAgent | null = null;
let insecureAgent: Agent | null = null;

function getProxyUrl(): string | null {
  return process.env.PROXY_URL || null;
}

function getProxyAgent(insecureTLS = false): ProxyAgent | null {
  const proxyUrl = getProxyUrl();
  if (!proxyUrl) return null;

  if (insecureTLS) {
    if (!insecureProxyAgent) {
      insecureProxyAgent = new ProxyAgent({
        uri: proxyUrl,
        requestTls: { rejectUnauthorized: false },
      });
    }
    return insecureProxyAgent;
  }

  if (!proxyAgent) {
    proxyAgent = new ProxyAgent(proxyUrl);
    console.log(`🌐 Proxy configured: ${proxyUrl.replace(/\/\/([^:]+):([^@]+)@/, "//$1:***@")}`);
  }
  return proxyAgent;
}

// A dispatcher that skips TLS chain verification, used only as a deliberate
// fallback when a site presents an incomplete certificate chain (a missing
// intermediate → UNABLE_TO_VERIFY_LEAF_SIGNATURE). Browsers recover from this
// via AIA fetching; Node's fetch does not, so without this fallback every page
// on such a site fails HTTP and is forced down the slow headless path.
function getInsecureAgent(): Agent {
  if (!insecureAgent) {
    insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });
  }
  return insecureAgent;
}

/**
 * Fetch that only routes through the configured proxy when asked to — keeping
 * residential-proxy bandwidth (and cost) for the requests that actually need
 * it. By default requests go direct (free); pass { useProxy: true } to route a
 * specific request through the proxy, or set PROXY_ALWAYS=true to force every
 * request through it (e.g. if the server's own IP is globally blocked).
 */
export async function proxyFetch(
  url: string | URL,
  init?: RequestInit,
  opts?: { useProxy?: boolean; insecureTLS?: boolean },
): Promise<Response> {
  // Sign the request (Web Bot Auth) when configured, so verifiers can recognise
  // us. No-op (returns null) when WEB_BOT_AUTH_PRIVATE_JWK is unset.
  let finalInit = init;
  try {
    const sigHeaders = await webBotAuthHeaders(url);
    if (sigHeaders) {
      finalInit = {
        ...init,
        headers: { ...((init?.headers as Record<string, string>) || {}), ...sigHeaders },
      };
    }
  } catch (err) {
    // Never let a signing failure block the crawl — fall back to unsigned.
    console.error("⚠️ Web Bot Auth signing failed, sending unsigned request:", err);
  }

  const alwaysProxy = process.env.PROXY_ALWAYS === "true";
  const insecureTLS = opts?.insecureTLS ?? false;
  const agent =
    opts?.useProxy || alwaysProxy ? getProxyAgent(insecureTLS) : null;
  if (agent) {
    return fetch(url, { ...finalInit, dispatcher: agent } as any);
  }
  if (insecureTLS) {
    return fetch(url, { ...finalInit, dispatcher: getInsecureAgent() } as any);
  }
  return fetch(url, finalInit);
}

export function getPuppeteerProxyArgs(): string[] {
  const proxyUrl = getProxyUrl();
  if (!proxyUrl) return [];

  try {
    const parsed = new URL(proxyUrl);
    return [`--proxy-server=${parsed.host}`];
  } catch {
    return [];
  }
}

export function getProxyCredentials(): { username: string; password: string } | null {
  const proxyUrl = getProxyUrl();
  if (!proxyUrl) return null;

  try {
    const parsed = new URL(proxyUrl);
    if (parsed.username && parsed.password) {
      return {
        username: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password),
      };
    }
  } catch {}
  return null;
}

export function isProxyConfigured(): boolean {
  return !!getProxyUrl();
}
