// Generate an Ed25519 keypair for Web Bot Auth and print the two JWKs to set as
// environment variables. Run locally (the private key is printed to your
// terminal only, never committed):
//
//   node scripts/generate-web-bot-auth-keys.mjs
//
// Then set:
//   crawl-rank-riot  WEB_BOT_AUTH_PRIVATE_JWK = <the private JWK line>
//   rank-riot        WEB_BOT_AUTH_PUBLIC_JWK  = <the public JWK line>
//
// Both JWKs share the same `kid` (the RFC 8037 thumbprint). The public key is
// served by the frontend at /.well-known/http-message-signatures-directory and
// referenced by the signature's keyid.

import { webcrypto } from "node:crypto";

const { subtle } = webcrypto;

const { publicKey, privateKey } = await subtle.generateKey(
  { name: "Ed25519" },
  true,
  ["sign", "verify"],
);

const pub = await subtle.exportKey("jwk", publicKey);
const priv = await subtle.exportKey("jwk", privateKey);

// RFC 8037 thumbprint for OKP keys: SHA-256 over {crv,kty,x} (sorted), base64url.
const canonical = JSON.stringify({ crv: pub.crv, kty: pub.kty, x: pub.x });
const digest = await subtle.digest("SHA-256", new TextEncoder().encode(canonical));
const kid = Buffer.from(new Uint8Array(digest)).toString("base64url");

pub.kid = kid;
priv.kid = kid;

console.log("\nkid (thumbprint):", kid, "\n");
console.log("WEB_BOT_AUTH_PUBLIC_JWK  (set on rank-riot / frontend):");
console.log(JSON.stringify(pub));
console.log("\nWEB_BOT_AUTH_PRIVATE_JWK (set on crawl-rank-riot / crawler — keep secret):");
console.log(JSON.stringify(priv));
console.log("");
