# Web Bot Auth

RankRiot signs its outbound crawl requests with an HTTP Message Signature
(RFC 9421), following the [web-bot-auth](https://github.com/cloudflare/web-bot-auth)
draft. This lets verifiers — Cloudflare, Shopify and others — cryptographically
recognise RankRiot instead of treating it as an unknown bot. It's the durable
fix for being blocked: once we're enrolled in Cloudflare's Verified Bots
program, signed requests are recognised across every Cloudflare-protected site
with no per-customer allowlisting.

## How it works

The crawler attaches three headers to each HTTP request (via `proxyFetch`):

- `Signature-Agent: "https://rankriot.app"` — the origin hosting our key directory.
- `Signature-Input` — covered components `("@authority" "signature-agent")`, plus
  `keyid` (Ed25519 JWK thumbprint), `alg="ed25519"`, `created`, `expires`
  (≤ 24h), a `nonce`, and `tag="web-bot-auth"`.
- `Signature` — the Ed25519 signature over those components.

The frontend (rank-riot) publishes the matching **public** key as a JWK Set at
`https://rankriot.app/.well-known/http-message-signatures-directory`. A verifier
reads `Signature-Agent`, fetches that directory, finds the key by `keyid`, and
verifies the signature.

## Setup

1. **Generate a keypair** (locally; the private key prints to your terminal only):

   ```
   node scripts/generate-web-bot-auth-keys.mjs
   ```

2. **Set environment variables** (both keys share the same `kid`):
   - Crawler (`crawl-rank-riot`): `WEB_BOT_AUTH_PRIVATE_JWK` = the private JWK.
     Optionally `WEB_BOT_AUTH_SIGNATURE_AGENT` (defaults to `https://rankriot.app`).
   - Frontend (`rank-riot`): `WEB_BOT_AUTH_PUBLIC_JWK` = the public JWK.

   Signing is OFF until `WEB_BOT_AUTH_PRIVATE_JWK` is set, so deploying the code
   changes nothing until you add the keys.

3. **Verify the directory** after deploy:

   ```
   curl https://rankriot.app/.well-known/http-message-signatures-directory
   ```

   It should return `{"keys":[{...}]}` with
   `Content-Type: application/http-message-signatures-directory+json`.

4. **Enrol in Cloudflare's Verified Bots program**: submit the directory URL via
   the Verified Bots form in the Cloudflare dashboard, choosing the Message
   Signatures / "Request Signature" method. Approval is a review (not instant),
   but signature-based applications are prioritised.

## Scope & limitations

- Only the **HTTP fetch path** (`proxyFetch`) is signed. Headless/Puppeteer
  requests are not yet covered — a follow-up would inject the same headers via
  request interception.
- The User-Agent token and the residential-proxy fallback remain in place for
  non-Cloudflare WAFs that haven't adopted the standard yet.
- Verify the exact wire format against Cloudflare's reference verifier before
  relying on it in production; the signed component set is pinned to the current
  draft (`("@authority" "signature-agent")`, `tag="web-bot-auth"`).
