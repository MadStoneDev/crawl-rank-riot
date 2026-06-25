import { webcrypto, randomUUID } from "node:crypto";

const { subtle } = webcrypto;

/**
 * Web Bot Auth — signs outbound requests with an HTTP Message Signature
 * (RFC 9421) so verifiers like Cloudflare and Shopify can cryptographically
 * recognise RankRiot instead of treating us as an unknown bot. This is the
 * durable fix for being blocked: once enrolled in Cloudflare's Verified Bots
 * program, signed requests are recognised across every Cloudflare-protected
 * site without per-customer allowlisting.
 *
 * We send three headers (Signature, Signature-Input, Signature-Agent) covering
 * `("@authority" "signature-agent")` per the web-bot-auth draft. The public key
 * is published by the frontend at
 * <agent>/.well-known/http-message-signatures-directory.
 *
 * Env:
 *   WEB_BOT_AUTH_PRIVATE_JWK     — JSON Ed25519 private JWK (with d, x, kid).
 *                                  Signing is OFF when this is unset.
 *   WEB_BOT_AUTH_SIGNATURE_AGENT — HTTPS origin hosting the key directory
 *                                  (default https://rankriot.app), no path.
 *
 * Generate a keypair with: node scripts/generate-web-bot-auth-keys.mjs
 * Only the HTTP fetch path (proxyFetch) is signed; headless/Puppeteer requests
 * are not yet covered.
 */

type Ed25519Jwk = JsonWebKey & { kid?: string };

function getPrivateJwk(): Ed25519Jwk | null {
  const raw = process.env.WEB_BOT_AUTH_PRIVATE_JWK;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Ed25519Jwk;
  } catch {
    console.error(
      "⚠️ WEB_BOT_AUTH_PRIVATE_JWK is set but not valid JSON — request signing disabled",
    );
    return null;
  }
}

export function isWebBotAuthEnabled(): boolean {
  return !!process.env.WEB_BOT_AUTH_PRIVATE_JWK;
}

function getSignatureAgent(): string {
  return (
    process.env.WEB_BOT_AUTH_SIGNATURE_AGENT || "https://rankriot.app"
  ).replace(/\/+$/, "");
}

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** RFC 8037 JWK thumbprint for an OKP (Ed25519) key. */
async function jwkThumbprint(jwk: Ed25519Jwk): Promise<string> {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return base64url(digest);
}

// Import the key once and reuse it; signing happens on every outbound request.
let cached: Promise<{ key: CryptoKey; kid: string }> | null = null;

function loadSigner(): Promise<{ key: CryptoKey; kid: string }> | null {
  const jwk = getPrivateJwk();
  if (!jwk) return null;
  if (!cached) {
    cached = (async () => {
      const key = await subtle.importKey(
        "jwk",
        jwk,
        { name: "Ed25519" },
        false,
        ["sign"],
      );
      const kid = jwk.kid || (await jwkThumbprint(jwk));
      return { key, kid };
    })();
  }
  return cached;
}

/**
 * Build the Signature / Signature-Input / Signature-Agent headers for a request
 * to `targetUrl`. Returns null when signing is disabled or the URL is invalid,
 * so callers can fall through to an unsigned request.
 */
export async function webBotAuthHeaders(
  targetUrl: string | URL,
): Promise<Record<string, string> | null> {
  const signerPromise = loadSigner();
  if (!signerPromise) return null;

  let authority: string;
  try {
    authority = new URL(targetUrl).host.toLowerCase();
  } catch {
    return null;
  }

  const { key, kid } = await signerPromise;
  const agent = getSignatureAgent();
  const created = Math.floor(Date.now() / 1000);
  const expires = created + 24 * 60 * 60; // draft recommends <= 24h
  const nonce = randomUUID();

  // Covered components + signature parameters (label `sig1`).
  const params =
    `("@authority" "signature-agent");keyid="${kid}";alg="ed25519";` +
    `created=${created};expires=${expires};nonce="${nonce}";tag="web-bot-auth"`;

  const signatureBase =
    `"@authority": ${authority}\n` +
    `"signature-agent": "${agent}"\n` +
    `"@signature-params": ${params}`;

  const signature = await subtle.sign(
    { name: "Ed25519" },
    key,
    new TextEncoder().encode(signatureBase),
  );

  return {
    Signature: `sig1=:${Buffer.from(new Uint8Array(signature)).toString("base64")}:`,
    "Signature-Input": `sig1=${params}`,
    "Signature-Agent": `"${agent}"`,
  };
}
