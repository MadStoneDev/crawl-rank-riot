import { ProxyAgent } from "undici";

let proxyAgent: ProxyAgent | null = null;

function getProxyUrl(): string | null {
  return process.env.PROXY_URL || null;
}

function getProxyAgent(): ProxyAgent | null {
  const proxyUrl = getProxyUrl();
  if (!proxyUrl) return null;

  if (!proxyAgent) {
    proxyAgent = new ProxyAgent(proxyUrl);
    console.log(`🌐 Proxy configured: ${proxyUrl.replace(/\/\/([^:]+):([^@]+)@/, "//$1:***@")}`);
  }
  return proxyAgent;
}

export function proxyFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const agent = getProxyAgent();
  if (agent) {
    return fetch(url, { ...init, dispatcher: agent } as any);
  }
  return fetch(url, init);
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
